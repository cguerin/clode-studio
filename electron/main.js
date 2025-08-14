import { app, BrowserWindow, ipcMain, shell, dialog } from 'electron';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import * as path from 'path';
import { spawn, fork } from 'child_process';
import Store from 'electron-store';
import * as pty from 'node-pty';
import { existsSync } from 'fs';
import * as fs from 'fs';
import { readFile, mkdir } from 'fs/promises';
import { watch as chokidarWatch } from 'chokidar';
import { homedir } from 'os';
import { claudeCodeService } from './claude-sdk-service.js';
import { workspaceContextManager } from './workspace-context-manager.js';
import { contextOptimizer } from './context-optimizer.js';
import { workspacePersistence } from './workspace-persistence.js';
import { searchWithRipgrep } from './search-ripgrep.js';
import { claudeSettingsManager as importedClaudeSettingsManager } from './claude-settings-manager.js';
import { ClaudeDetector } from './claude-detector.js';
import { fileWatcherService } from './file-watcher.js';
import { createKnowledgeCache } from './knowledge-cache.js';
import { GitServiceManager } from './git-service-manager.js';
import { WorktreeManagerGlobal } from './worktree-manager-global.js';
import { GitHooksManagerGlobal } from './git-hooks-manager-global.js';
import { SnapshotService } from './snapshot-service.js';
import { setupGitTimelineHandlers } from './git-timeline-handlers.js';
import { ghostTextService } from './ghost-text-service.js';
// LocalDatabase removed - SQLite not actively used
import { getModeManager, MainProcessMode } from './services/mode-config.js';
import { RemoteServer } from './services/remote-server.js';
import { CloudflareTunnel } from './services/cloudflare-tunnel.js';
import { RelayClient } from './services/relay-client.js';
// Load environment variables from .env file
import { config } from 'dotenv';
config();
// GLOBAL IPC FLOOD DETECTION: Track ALL webContents.send calls
let globalIPCCount = 0;
let lastIPCLogTime = 0;
let ipcChannelCounts = {};
function setupGlobalIPCTracking(window) {
    const originalSend = window.webContents.send.bind(window.webContents);
    window.webContents.send = function (channel, ...args) {
        globalIPCCount++;
        ipcChannelCounts[channel] = (ipcChannelCounts[channel] || 0) + 1;
        const now = Date.now();
        // Log every 1000 messages or every 1 second for rapid detection
        if (globalIPCCount % 1000 === 0 || (now - lastIPCLogTime > 1000)) {
            const topChannels = Object.entries(ipcChannelCounts)
                .sort(([, a], [, b]) => b - a)
                .slice(0, 3)
                .map(([ch, count]) => `${ch}:${count}`)
                .join(', ');
            console.warn(`[IPC FLOOD] Total: ${globalIPCCount}, Top: ${topChannels}`);
            lastIPCLogTime = now;
        }
        // Emergency brake for ANY IPC channel
        if (globalIPCCount > 50000) {
            console.error(`[EMERGENCY] Blocking ALL IPC after ${globalIPCCount}. Channel: ${channel}`);
            return;
        }
        // SMART BLOCKING: Only block if channel is truly flooded AND we're in an infinite loop
        if (ipcChannelCounts[channel] > 5000 && channel.includes('claude:output:')) {
            // Extract instance ID from channel name
            const instanceId = channel.split(':').pop();
            if (instanceId && global.claudeMessageTracking) {
                const tracking = global.claudeMessageTracking.get(instanceId);
                // Only block if we're actually in an infinite loop, not just high activity
                if (tracking && tracking.blocked && tracking.identicalCount > 10) {
                    console.error(`[CHANNEL FLOOD] Blocking OUTPUT channel ${channel} - infinite loop detected (${tracking.identicalCount} identical messages)`);
                    return;
                } else {
                    // High message count but not an infinite loop - allow through with warning
                    console.warn(`[CHANNEL BUSY] High activity on ${channel} (${ipcChannelCounts[channel]} messages) but no infinite loop detected - allowing`);
                }
            }
        }
        return originalSend(channel, ...args);
    };
}
// Memory and error monitoring
process.on('uncaughtException', async (error) => {
    console.error('Uncaught Exception:', error);
    // Try to clean up and save state before crashing
    try {
        await workspaceContextManager.closeAllWorkspaces();
    }
    catch (e) {
        console.error('Error during emergency cleanup:', e);
    }
    process.exit(1);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});
// Monitor memory usage
setInterval(() => {
    const usage = process.memoryUsage();
    const heapUsedMB = usage.heapUsed / 1024 / 1024;
    if (heapUsedMB > 6000) { // 6GB warning threshold
        console.warn(`Main process high memory usage: ${heapUsedMB.toFixed(2)}MB`);
        // Emergency cleanup
        try {
            if (global.pendingClaudeOutput) {
                global.pendingClaudeOutput.clear();
                console.log('Cleared pending Claude output due to high memory usage');
            }
        }
        catch (error) {
            console.error('Error during emergency memory cleanup:', error);
        }
    }
}, 60000); // Check every minute
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
let mainWindow = null;
const store = new Store();
const fileWatchers = new Map();
// Multi-instance Claude support
const claudeInstances = new Map();
// Mode manager and remote server
const modeManager = getModeManager();
let remoteServer = null;
let cloudflareTunnel = null;
let relayClient = null;
// Claude settings manager
const claudeSettingsManager = importedClaudeSettingsManager;
// Knowledge cache instances per workspace
const knowledgeCaches = new Map();
// Git service instances per workspace
const gitServices = new Map();
// Worktree manager instances per workspace
const worktreeManagers = new Map();
// Git hooks manager instances per workspace - now handled by GitHooksManagerGlobal
// const gitHooksManagers: Map<string, GitHooksManager> = new Map();
// Snapshot service instances per workspace
const snapshotServices = new Map();
const isDev = process.env.NODE_ENV !== 'production';
let nuxtURL = 'http://localhost:3000';
let serverProcess = null;
// Start Nuxt server function
const startNuxtServer = async () => {
    return new Promise((resolve, reject) => {
        if (!app.isPackaged) {
            // Development mode - server is already running via npm run dev
            console.log('Development mode - using existing server');
            setTimeout(resolve, 100);
            return;
        }
        // Production mode - start the Nuxt server from extraResources
        console.log('Starting Nuxt server in production...');
        // Get the path to the server in extraResources
        const resourcesPath = process.resourcesPath;
        const serverPath = join(resourcesPath, '.output', 'server', 'index.mjs');
        console.log('Server path:', serverPath);
        if (!existsSync(serverPath)) {
            console.error('Server file not found at:', serverPath);
            reject(new Error('Server file not found'));
            return;
        }
        // Fork the server process
        serverProcess = fork(serverPath, [], {
            env: {
                ...process.env,
                PORT: '3000',
                HOST: 'localhost',
                NODE_ENV: 'production',
                NITRO_PORT: '3000',
                NITRO_HOST: 'localhost'
            },
            silent: true // Capture stdout/stderr
        });
        let serverStarted = false;
        serverProcess.stdout?.on('data', (data) => {
            const message = data.toString();
            console.log('Nuxt:', message);
            // Check if server is ready
            if (!serverStarted && (message.includes('3000') || message.includes('Listening') || message.includes('ready'))) {
                serverStarted = true;
                console.log('Nuxt server is ready!');
                setTimeout(resolve, 500); // Give it a moment to stabilize
            }
        });
        serverProcess.stderr?.on('data', (data) => {
            console.error('Nuxt Error:', data.toString());
        });
        serverProcess.on('error', (error) => {
            console.error('Failed to start Nuxt server:', error);
            reject(error);
        });
        serverProcess.on('exit', (code) => {
            console.log('Nuxt server exited with code:', code);
        });
        // Timeout fallback
        setTimeout(() => {
            if (!serverStarted) {
                console.log('Server start timeout - proceeding anyway');
                resolve();
            }
        }, 5000);
    });
};
// Clean up server on quit
app.on('before-quit', async (event) => {
    event.preventDefault(); // Prevent immediate quit
    if (serverProcess) {
        console.log('Stopping Nuxt server...');
        serverProcess.kill();
    }
    // Clean up all pending Claude output
    if (global.pendingClaudeOutput && global.pendingClaudeOutput.size > 0) {
        console.log('Cleaning up all pending Claude output...');
        global.pendingClaudeOutput.clear();
    }
    // Clean up workspace contexts
    try {
        await workspaceContextManager.shutdown();
        console.log('Workspace context manager shut down');
    }
    catch (error) {
        console.error('Error shutting down workspace context manager:', error);
    }
    app.quit(); // Now actually quit
    // Kill all Claude instances
    claudeInstances.forEach((pty, instanceId) => {
        console.log(`Killing Claude instance ${instanceId}`);
        try {
            pty.kill();
        }
        catch (error) {
            console.error(`Failed to kill Claude instance ${instanceId}:`, error);
        }
    });
    claudeInstances.clear();
});
function createWindow() {
    // Set up icon path
    const iconPath = process.platform === 'darwin'
        ? join(__dirname, '..', 'build', 'icon.icns')
        : process.platform === 'win32'
            ? join(__dirname, '..', 'build', 'icon.ico')
            : join(__dirname, '..', 'build', 'icon.png');
    mainWindow = new BrowserWindow({
        width: 1600,
        height: 1000,
        minWidth: 1200,
        minHeight: 800,
        title: 'Clode Studio',
        icon: existsSync(iconPath) ? iconPath : undefined,
        webPreferences: {
            preload: join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            webSecurity: !isDev
        },
        titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
        trafficLightPosition: { x: 15, y: 13 }, // macOS traffic light position
        backgroundColor: '#1e1e1e',
        show: false
    });
    mainWindow.loadURL(nuxtURL);
    // Set up IPC flood detection immediately after window creation
    setupGlobalIPCTracking(mainWindow);
    console.log('[IPC TRACKING] Global IPC flood detection enabled');
    mainWindow.once('ready-to-show', () => {
        mainWindow?.show();
        if (isDev) {
            mainWindow?.webContents.openDevTools();
        }
        // Update remote server with new window reference if it exists
        if (remoteServer && mainWindow) {
            remoteServer.updateMainWindow(mainWindow);
        }
        // Flush any pending Claude output
        if (global.pendingClaudeOutput && global.pendingClaudeOutput.size > 0) {
            console.log('Flushing pending Claude output to new window');
            setTimeout(() => {
                global.pendingClaudeOutput?.forEach((output, instanceId) => {
                    if (output && mainWindow && !mainWindow.isDestroyed()) {
                        console.log(`Flushing ${output.length} chars for instance ${instanceId}`);
                        mainWindow.webContents.send(`claude:output:${instanceId}`, output);
                    }
                });
                global.pendingClaudeOutput?.clear();
            }, 1000); // Give renderer time to set up listeners
        }
    });
    mainWindow.on('closed', () => {
        mainWindow = null;
        // Clean up all Claude instances
        claudeInstances.forEach((pty, instanceId) => {
            pty.kill();
        });
        claudeInstances.clear();
    });
}
app.whenReady().then(async () => {
    // Log the current mode
    // Start Nuxt server first (in production)
    if (app.isPackaged) {
        try {
            console.log('Starting Nuxt server for production...');
            await startNuxtServer();
            console.log('Nuxt server started successfully');
        }
        catch (error) {
            console.error('Failed to start Nuxt server:', error);
            // Optionally show error dialog and quit
            dialog.showErrorBox('Server Error', 'Failed to start the application server. Please try again.');
            app.quit();
            return;
        }
    }
    // Initialize all service managers (singletons)
    GitServiceManager.getInstance();
    WorktreeManagerGlobal.getInstance();
    GitHooksManagerGlobal.getInstance();
    // LocalDatabase removed - SQLite not actively used
    const workspacePath = store.get('workspacePath');
    // Initialize autocomplete services
    await ghostTextService.initialize();
    // Setup Git Timeline handlers
    setupGitTimelineHandlers();
    createWindow();
    // Set up periodic cleanup of orphaned pending output (every 5 minutes)
    setInterval(() => {
        if (global.pendingClaudeOutput && global.pendingClaudeOutput.size > 0) {
            // Check for orphaned entries (instances that no longer exist)
            const activeInstances = new Set(claudeInstances.keys());
            let cleanedCount = 0;
            global.pendingClaudeOutput.forEach((output, instanceId) => {
                if (!activeInstances.has(instanceId)) {
                    console.log(`Cleaning up orphaned pending output for ${instanceId}`);
                    global.pendingClaudeOutput?.delete(instanceId);
                    cleanedCount++;
                }
            });
            if (cleanedCount > 0) {
                console.log(`Cleaned up ${cleanedCount} orphaned pending output entries`);
            }
        }
    }, 5 * 60 * 1000); // 5 minutes
    // Check if hybrid mode was enabled in settings and auto-start it
    const savedHybridMode = store.get('hybridModeEnabled');
    const savedRelayType = store.get('relayType') || 'CLODE';
    const savedCustomUrl = store.get('customRelayUrl');
    if (savedHybridMode && !modeManager.isHybridMode()) {
        console.log('[Main] Auto-starting hybrid mode from saved settings...');
        console.log('[Main] Using saved relay type:', savedRelayType);
        if (savedCustomUrl) {
            console.log('[Main] Using custom relay URL:', savedCustomUrl);
        }
        // Enable hybrid mode with saved relay type and custom URL
        setTimeout(async () => {
            try {
                const result = await enableHybridMode(savedRelayType, savedCustomUrl);
                if (result && result.success) {
                    console.log('[Main] Hybrid mode auto-started successfully');
                    // Notify the UI that hybrid mode is enabled
                    mainWindow?.webContents.send('hybrid-mode-enabled', { relayType: savedRelayType });
                }
                else {
                    console.error('[Main] Failed to auto-start hybrid mode:', result?.error);
                }
            }
            catch (error) {
                console.error('[Main] Error auto-starting hybrid mode:', error);
            }
        }, 3000); // Delay to ensure window is ready
    }
    // Initialize remote server if in hybrid mode (from env var)
    if (modeManager.isHybridMode() && mainWindow) {
        const config = modeManager.getConfig();
        remoteServer = new RemoteServer({
            config,
            mainWindow
        });
        try {
            await remoteServer.start();
            // Make remote server globally accessible for handlers
            global.__remoteServer = remoteServer;
            // Set up IPC handler for terminal data forwarding
            ipcMain.on('forward-terminal-data', (event, data) => {
                if (remoteServer && data.socketId && data.terminalId) {
                    remoteServer.forwardTerminalData(data.socketId, data.terminalId, data.data);
                }
            });
            // Set up IPC handler for Claude output forwarding
            ipcMain.on('forward-claude-output', (event, data) => {
                if (remoteServer && data.socketId && data.instanceId) {
                    remoteServer.forwardClaudeOutput(data.socketId, data.instanceId, data.data);
                }
            });
            // Set up IPC handler for Claude response complete forwarding
            ipcMain.on('forward-claude-response-complete', (event, data) => {
                if (remoteServer && data.socketId && data.instanceId) {
                    remoteServer.forwardClaudeResponseComplete(data.socketId, data.instanceId);
                }
                else {
                    console.log('[Main] ❌ Missing requirements for forwarding:', {
                        remoteServer: !!remoteServer,
                        socketId: !!data.socketId,
                        instanceId: !!data.instanceId
                    });
                }
            });
            // Set up IPC handler for Claude instance updates
            ipcMain.on('claude-instances-updated', () => {
                if (remoteServer) {
                    remoteServer.broadcastClaudeInstancesUpdate();
                }
                // Also notify the desktop UI
                mainWindow?.webContents.send('claude:instances:updated');
            });
            // Initialize tunnel/relay based on RELAY_TYPE environment variable
            // Options: CLODE (default), CLOUDFLARE, CUSTOM
            const relayType = (process.env.RELAY_TYPE || process.env.USE_RELAY || 'CLODE').toUpperCase();
            console.log(`[Main] Using relay type: ${relayType}`);
            switch (relayType) {
                case 'CLODE':
                case 'TRUE': // Backward compatibility with USE_RELAY=true
                    // Use Clode relay server (default behavior)
                    relayClient = new RelayClient(process.env.RELAY_URL || 'wss://relay.clode.studio');
                    relayClient.on('registered', (info) => {
                        console.log(`[Main] Clode Relay registered: ${info.url}`);
                        mainWindow?.webContents.send('relay:connected', info);
                    });
                    relayClient.on('reconnected', () => {
                        console.log('[Main] Clode Relay reconnected');
                        mainWindow?.webContents.send('relay:reconnected');
                    });
                    relayClient.on('connection_lost', () => {
                        console.log('[Main] Clode Relay connection lost');
                        mainWindow?.webContents.send('relay:disconnected');
                    });
                    // Connect to relay after server is ready
                    setTimeout(async () => {
                        try {
                            const info = await relayClient.connect();
                            console.log(`[Main] Connected to Clode Relay: ${info.url}`);
                            global.__relayClient = relayClient;
                        }
                        catch (error) {
                            console.error('[Main] Failed to connect to Clode Relay:', error);
                            // Continue without relay - fallback to local network
                        }
                    }, 2000);
                    break;
                case 'CLOUDFLARE':
                    // Use Cloudflare tunnel
                    console.log('[Main] Initializing Cloudflare tunnel...');
                    cloudflareTunnel = new CloudflareTunnel();
                    // Set up tunnel status updates
                    cloudflareTunnel.onStatusUpdated((tunnelInfo) => {
                        // Send tunnel info to renderer process
                        mainWindow?.webContents.send('tunnel:status-updated', tunnelInfo);
                        console.log('[Main] Cloudflare tunnel status:', tunnelInfo);
                    });
                    // Start tunnel (wait a bit for Nuxt to be ready)
                    setTimeout(async () => {
                        try {
                            await cloudflareTunnel?.start();
                            console.log('[Main] Cloudflare tunnel started successfully');
                        }
                        catch (tunnelError) {
                            console.error('[Main] Failed to start Cloudflare tunnel:', tunnelError);
                            // Tunnel failure shouldn't break the app, just log it
                        }
                    }, 2000); // Wait 2 seconds for Nuxt server to be ready
                    break;
                case 'CUSTOM':
                    // User will provide their own tunnel solution (ngrok, serveo, etc.)
                    // Custom tunnels should expose port 3000 (Nuxt UI), not 3789 (remote server)
                    const uiPort = 3000;
                    console.log('[Main] Custom tunnel mode - user will provide their own tunnel');
                    console.log('[Main] UI server running on port:', uiPort);
                    console.log('[Main] Remote server running on port:', config.serverPort);
                    console.log('[Main] To expose your app, use one of these commands:');
                    console.log(`[Main]   tunnelmole: npx tunnelmole@latest ${uiPort}`);
                    console.log(`[Main]   localtunnel: npx localtunnel --port ${uiPort}`);
                    console.log(`[Main]   ngrok: ngrok http ${uiPort}`);
                    console.log(`[Main]   serveo: ssh -R 80:localhost:${uiPort} serveo.net`);
                    console.log(`[Main]   bore: bore local ${uiPort} --to bore.pub`);
                    // Send a message to the renderer that custom mode is active
                    setTimeout(() => {
                        mainWindow?.webContents.send('tunnel:custom-mode', {
                            port: uiPort,
                            message: 'Please set up your own tunnel solution for port 3000',
                            suggestions: [
                                `npx tunnelmole@latest ${uiPort}`,
                                `npx localtunnel --port ${uiPort}`,
                                `ngrok http ${uiPort}`,
                                `ssh -R 80:localhost:${uiPort} serveo.net`,
                                `bore local ${uiPort} --to bore.pub`
                            ]
                        });
                    }, 2000);
                    break;
                case 'FALSE':
                case 'NONE':
                    // No tunnel/relay - local network only
                    console.log('[Main] No tunnel/relay - local network access only');
                    console.log('[Main] UI available at http://localhost:3000');
                    console.log('[Main] Remote server available at http://localhost:' + config.serverPort);
                    setTimeout(() => {
                        mainWindow?.webContents.send('tunnel:local-only', {
                            port: 3000,
                            serverPort: config.serverPort,
                            message: 'Local network access only'
                        });
                    }, 2000);
                    break;
                default:
                    console.warn(`[Main] Unknown RELAY_TYPE: ${relayType}, falling back to CLODE`);
                    // Fall back to CLODE relay
                    relayClient = new RelayClient(process.env.RELAY_URL || 'wss://relay.clode.studio');
                    setTimeout(async () => {
                        try {
                            const info = await relayClient.connect();
                            console.log(`[Main] Connected to relay: ${info.url}`);
                            global.__relayClient = relayClient;
                        }
                        catch (error) {
                            console.error('[Main] Failed to connect to relay:', error);
                        }
                    }, 2000);
            }
        }
        catch (error) {
            console.error('Failed to start remote server:', error);
            dialog.showErrorBox('Remote Server Error', `Failed to start remote server: ${error.message}`);
        }
    }
    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
            // After creating new window, update remote server reference
            if (remoteServer && mainWindow) {
                // Give window time to be ready
                setTimeout(() => {
                    if (remoteServer && mainWindow) {
                        remoteServer.updateMainWindow(mainWindow);
                    }
                }, 100);
            }
        }
    });
});
app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});
// Claude Process Management using PTY with multi-instance support
ipcMain.handle('claude:start', async (event, instanceId, workingDirectory, instanceName, runConfig) => {
    if (claudeInstances.has(instanceId)) {
        // Instance already running - return success with existing PID
        const existingPty = claudeInstances.get(instanceId);
        const pid = existingPty?.pid || -1;
        // Get Claude info for response
        const claudeInfo = await ClaudeDetector.detectClaude(workingDirectory);
        return {
            success: true,
            pid,
            claudeInfo,
            alreadyRunning: true
        };
    }
    try {
        // Configure MCP server for this Claude instance
        await claudeSettingsManager.configureClodeIntegration(instanceId, workingDirectory);
        // Detect Claude installation
        const claudeInfo = await ClaudeDetector.detectClaude(workingDirectory);
        // Get the command configuration
        // Claude starts in interactive mode by default when run without arguments
        const debugArgs = process.env.CLAUDE_DEBUG === 'true' ? ['--debug'] : [];
        let { command, args: commandArgs, useShell } = ClaudeDetector.getClaudeCommand(claudeInfo, debugArgs);
        // Override with run config if provided
        if (runConfig) {
            if (runConfig.command) {
                // If the command is just 'claude', use the detected path
                command = runConfig.command === 'claude' ? command : runConfig.command;
            }
            if (runConfig.args && runConfig.args.length > 0) {
                // When we have custom args, we need to rebuild the command
                const allArgs = [...runConfig.args, ...debugArgs];
                const result = ClaudeDetector.getClaudeCommand(claudeInfo, allArgs);
                command = result.command;
                commandArgs = result.args;
                useShell = result.useShell;
            }
        }
        // Log settings file to verify it exists
        const settingsPath = join(homedir(), '.claude', 'settings.json');
        if (!existsSync(settingsPath)) {
            console.warn('Claude settings file not found!');
        }
        // Get the user's default shell
        const userShell = process.env.SHELL || '/bin/bash';
        console.log('Spawning Claude with:', { command, commandArgs, useShell });
        // Add error handling for spawn
        let claudePty;
        try {
            // PTY ISOLATION FIX: Create clean environment without TTY inheritance
            const cleanEnv = {
                // Essential system variables only
                HOME: process.env.HOME,
                USER: process.env.USER,
                PATH: process.env.PATH,
                LANG: process.env.LANG || 'en_US.UTF-8',
                // Terminal settings for Claude display only
                FORCE_COLOR: '1',
                TERM: 'xterm-256color',
                SHELL: userShell,
                // Claude-specific instance variables
                CLAUDE_INSTANCE_ID: instanceId,
                CLAUDE_INSTANCE_NAME: instanceName || `Claude-${instanceId.slice(7, 15)}`,
                CLAUDE_IDE_INSTANCE: 'true',
                // REMOVED: FORCE_TTY which caused external terminal bleeding
            };
            claudePty = pty.spawn(command, commandArgs, {
                name: 'xterm-color',
                cols: 80,
                rows: 30,
                cwd: workingDirectory,
                env: cleanEnv, // Use clean isolated environment  
                handleFlowControl: true
            });
        }
        catch (error) {
            console.error('Failed to spawn Claude:', error);
            mainWindow?.webContents.send('claude-error', {
                instanceId,
                error: `Failed to spawn Claude: ${error instanceof Error ? error.message : String(error)}`
            });
            return { success: false, error: error instanceof Error ? error.message : String(error) };
        }
        // Store this instance
        claudeInstances.set(instanceId, claudePty);
        // Capture initial output for debugging
        let initialOutput = '';
        let outputTimer = null;
        // MEMORY LEAK FIX: Target ONLY the specific infinite loop issue, not normal keystrokes
        let lastLargeMessage = '';
        let largeMessageCount = 0;
        let totalDataCount = 0;
        let lastLogTime = 0;
        const LARGE_MESSAGE_THRESHOLD = 50; // Lower threshold - track messages > 50 characters  
        const MAX_IDENTICAL_LARGE_MESSAGES = 20; // Much more aggressive - block after 20 repeats
        const LOG_INTERVAL = 5000; // Log at most every 5 seconds
        // Handle output from Claude
        claudePty.onData((data) => {
            totalDataCount++;
            // EMERGENCY PROTECTION: Block runaway IPC regardless of message content
            if (totalDataCount > 10000) { // Emergency brake at 10k messages
                const now = Date.now();
                if (now - lastLogTime > LOG_INTERVAL) {
                    console.error(`[EMERGENCY] Blocking Claude PTY after ${totalDataCount} messages for ${instanceId}`);
                    lastLogTime = now;
                }
                return; // Block all further messages after 10k
            }
            // TARGETED PROTECTION: Only block large identical messages (the actual memory leak source)
            if (data.length > LARGE_MESSAGE_THRESHOLD) {
                if (data === lastLargeMessage) {
                    largeMessageCount++;
                    if (largeMessageCount > MAX_IDENTICAL_LARGE_MESSAGES) {
                        const now = Date.now();
                        // Only log occasionally to prevent log spam
                        if (now - lastLogTime > LOG_INTERVAL) {
                            console.warn(`[MEMORY LEAK FIX] Blocking large message loop for ${instanceId} - ${largeMessageCount} identical ${data.length}-char messages`);
                            lastLogTime = now;
                        }
                        return; // Block only large repeated messages
                    }
                }
                else {
                    lastLargeMessage = data;
                    largeMessageCount = 0; // Reset counter on different large message
                }
            }
            // NOTE: Small messages (keystrokes, prompts) are never blocked
            // Capture first few outputs for debugging (reduced logging)
            if (initialOutput.length < 1000) {
                initialOutput += data;
                // Log initial output after a short delay
                if (outputTimer)
                    clearTimeout(outputTimer);
                outputTimer = setTimeout(() => {
                    if (initialOutput.trim()) {
                        console.log(`Initial Claude output for ${instanceId}:`, initialOutput);
                    }
                }, 500);
            }
            // Send data with instance ID to all windows (reduced logging)
            const windows = BrowserWindow.getAllWindows();
            if (windows.length === 0) {
                console.warn('No windows available to send Claude output to!');
                // Store output to send when window becomes available
                if (!global.pendingClaudeOutput) {
                    global.pendingClaudeOutput = new Map();
                }
                const pending = global.pendingClaudeOutput.get(instanceId) || '';
                // MUCH SMALLER LIMIT to prevent memory explosion (1MB instead of 10MB)
                const MAX_PENDING_SIZE = 1 * 1024 * 1024; // 1MB limit
                const newPending = pending + data;
                if (newPending.length > MAX_PENDING_SIZE) {
                    // Keep only the last portion of the output
                    global.pendingClaudeOutput.set(instanceId, newPending.slice(-MAX_PENDING_SIZE));
                    console.warn(`Pending output for ${instanceId} exceeded limit, truncating...`);
                }
                else {
                    global.pendingClaudeOutput.set(instanceId, newPending);
                }
            }
            else {
                // DEBUG: Log what's being sent to understand the massive memory usage
                const dataSize = data.length;
                const dataType = typeof data;
                const dataPreview = data.length > 200 ? data.substring(0, 200) + '...[TRUNCATED]' : data;
                if (dataSize > 1000) {
                    console.warn(`[LARGE IPC] Sending ${dataSize} chars to ${instanceId}. Preview: ${JSON.stringify(dataPreview)}`);
                }
                // AGGRESSIVE: Block much smaller messages due to "changes in size" issue
                if (dataSize > 5000) { // 5KB limit - much more aggressive  
                    console.error(`[LARGE DATA BLOCK] Blocking ${dataSize} char message to prevent accumulation. Preview: ${JSON.stringify(dataPreview.substring(0, 100))}`);
                    return;
                }
                // LIGHTWEIGHT: Simple rate limiting without expensive hashing
                const now = Date.now();
                // Initialize per-instance tracking
                if (!global.claudeMessageTracking) {
                    global.claudeMessageTracking = new Map();
                }
                let tracking = global.claudeMessageTracking.get(instanceId);
                if (!tracking) {
                    tracking = {
                        messageCount: 0,
                        lastResetTime: now,
                        blocked: false,
                        lastMessageContent: '',
                        identicalCount: 0
                    };
                    global.claudeMessageTracking.set(instanceId, tracking);
                }
                // Reset counters every 30 seconds to allow recovery from blocks
                if (now - tracking.lastResetTime > 30000) {
                    tracking.messageCount = 0;
                    tracking.lastResetTime = now;
                    tracking.blocked = false;
                    tracking.identicalCount = 0;
                    console.log(`[LOOP DETECTION] Reset tracking for ${instanceId}`);
                }
                tracking.messageCount++;
                // SIMPLE INFINITE LOOP DETECTION: Check if identical to last message
                if (data === tracking.lastMessageContent) {
                    tracking.identicalCount++;
                    if (tracking.identicalCount > 10) {
                        console.error(`[INFINITE LOOP DETECTED] Identical message repeated ${tracking.identicalCount} times for ${instanceId}`);
                        tracking.blocked = true;
                        return;
                    }
                }
                else {
                    tracking.identicalCount = 0;
                    tracking.lastMessageContent = data;
                }
                // SIMPLE RATE LIMITING: Block if too many messages per second
                if (tracking.messageCount > 100) {
                    const timeWindow = now - tracking.lastResetTime;
                    const messagesPerSecond = (tracking.messageCount * 1000) / timeWindow;
                    if (messagesPerSecond > 50) {
                        console.error(`[RATE LIMIT] Blocking ${instanceId}: ${messagesPerSecond.toFixed(1)} msg/sec (limit: 50/sec)`);
                        tracking.blocked = true;
                        return;
                    }
                }
                // Skip sending if instance is blocked
                if (tracking.blocked) {
                    return;
                }
                windows.forEach(window => {
                    if (!window.isDestroyed()) {
                        window.webContents.send(`claude:output:${instanceId}`, data);
                    }
                });
            }
        });
        // Handle exit
        claudePty.onExit(async ({ exitCode, signal }) => {
            console.log(`Claude process exited for ${instanceId}:`, { exitCode, signal });
            // Log any captured output if process exits quickly
            if (initialOutput.trim()) {
                console.log(`Claude output before exit for ${instanceId}:`, initialOutput);
            }
            // Clean up pending output for this instance to prevent memory leak
            if (global.pendingClaudeOutput?.has(instanceId)) {
                console.log(`Cleaning up pending output for ${instanceId}`);
                global.pendingClaudeOutput.delete(instanceId);
            }
            // Send exit event to all windows
            const windows = BrowserWindow.getAllWindows();
            windows.forEach(window => {
                if (!window.isDestroyed()) {
                    window.webContents.send(`claude:exit:${instanceId}`, exitCode);
                }
            });
            claudeInstances.delete(instanceId);
            // Clean up message tracking for this instance to prevent memory leak
            if (global.claudeMessageTracking?.has(instanceId)) {
                console.log(`Cleaning up message tracking for exited instance ${instanceId}`);
                global.claudeMessageTracking.delete(instanceId);
            }
            // Clean up MCP server configuration
            try {
                await claudeSettingsManager.cleanupClodeIntegration();
            }
            catch (error) {
                console.error('Failed to clean up MCP server configuration:', error);
            }
            // Notify all clients about instance update
            mainWindow?.webContents.send('claude:instances:updated');
            if (remoteServer) {
                remoteServer.broadcastClaudeInstancesUpdate();
            }
            // Broadcast the exit/disconnection
            if (remoteServer) {
                remoteServer.broadcastClaudeStatusUpdate(instanceId, 'disconnected');
            }
        });
        // Notify all clients about instance update
        mainWindow?.webContents.send('claude:instances:updated');
        if (remoteServer) {
            remoteServer.broadcastClaudeInstancesUpdate();
        }
        // Broadcast the successful start with PID
        if (remoteServer) {
            remoteServer.broadcastClaudeStatusUpdate(instanceId, 'connected', claudePty.pid);
        }
        return {
            success: true,
            pid: claudePty.pid,
            claudeInfo: {
                path: claudeInfo.path,
                version: claudeInfo.version,
                source: claudeInfo.source
            }
        };
    }
    catch (error) {
        console.error(`Failed to start Claude for ${instanceId}:`, error);
        return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
});
ipcMain.handle('claude:send', async (event, instanceId, command) => {
    const claudePty = claudeInstances.get(instanceId);
    if (!claudePty) {
        return { success: false, error: `Claude instance is not running. Please start a Claude instance in the terminal first.` };
    }
    try {
        // Write raw data to PTY (xterm.js will handle line endings)
        claudePty.write(command);
        return { success: true };
    }
    catch (error) {
        console.error(`Failed to send command to Claude PTY ${instanceId}:`, error);
        return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
});
ipcMain.handle('claude:stop', async (event, instanceId) => {
    const claudePty = claudeInstances.get(instanceId);
    if (claudePty) {
        claudePty.kill();
        claudeInstances.delete(instanceId);
        // Clean up pending output for this instance
        if (global.pendingClaudeOutput?.has(instanceId)) {
            console.log(`Cleaning up pending output for stopped instance ${instanceId}`);
            global.pendingClaudeOutput.delete(instanceId);
        }
        // Clean up message tracking for this instance to prevent memory leak
        if (global.claudeMessageTracking?.has(instanceId)) {
            console.log(`Cleaning up message tracking for stopped instance ${instanceId}`);
            global.claudeMessageTracking.delete(instanceId);
        }
        // Notify all clients about instance update
        mainWindow?.webContents.send('claude:instances:updated');
        if (remoteServer) {
            remoteServer.broadcastClaudeInstancesUpdate();
        }
        // Broadcast the disconnection
        if (remoteServer) {
            remoteServer.broadcastClaudeStatusUpdate(instanceId, 'disconnected');
        }
        return { success: true };
    }
    return { success: false, error: `No Claude PTY running for instance ${instanceId}` };
});
// Check if a Claude instance is being forwarded from remote
ipcMain.handle('check-claude-forwarding', async (event, instanceId) => {
    if (!mainWindow)
        return false;
    try {
        // Check if the instance is in the forwarding map on the renderer side
        const isForwarded = await mainWindow.webContents.executeJavaScript(`
      (() => {
        if (window.__remoteClaudeForwarding) {
          return window.__remoteClaudeForwarding.has('${instanceId}');
        }
        return false;
      })()
    `);
        return isForwarded;
    }
    catch (error) {
        console.error('Failed to check Claude forwarding:', error);
        return false;
    }
});
ipcMain.handle('claude:resize', async (event, instanceId, cols, rows) => {
    const claudePty = claudeInstances.get(instanceId);
    if (claudePty) {
        try {
            claudePty.resize(cols, rows);
            return { success: true };
        }
        catch (error) {
            console.error(`Failed to resize PTY for ${instanceId}:`, error);
            return { success: false, error: error instanceof Error ? error.message : String(error) };
        }
    }
    return { success: false, error: `No Claude PTY running for instance ${instanceId}` };
});
// Recovery handler to unblock Claude instances
ipcMain.handle('claude:unblock', async (event, instanceId) => {
    if (!global.claudeMessageTracking) {
        return { success: false, error: 'No tracking data available' };
    }
    const tracking = global.claudeMessageTracking.get(instanceId);
    if (tracking) {
        // Reset all tracking data to unblock the instance
        tracking.blocked = false;
        tracking.messageCount = 0;
        tracking.identicalCount = 0;
        tracking.lastResetTime = Date.now();
        tracking.lastMessageContent = '';
        console.log(`[RECOVERY] Unblocked Claude instance ${instanceId}`);
        return { success: true };
    }
    return { success: false, error: `No tracking data for instance ${instanceId}` };
});
// Get home directory
ipcMain.handle('getHomeDir', () => {
    return homedir();
});
// Show notification
ipcMain.handle('showNotification', async (event, options) => {
    const { Notification } = await import('electron');
    if (Notification.isSupported()) {
        new Notification(options).show();
    }
    return { success: true };
});
// File Watcher operations
ipcMain.handle('fileWatcher:start', async (event, dirPath, options) => {
    try {
        // Use VERY conservative settings to prevent EMFILE while still allowing functionality
        console.log(`[Main] Starting conservative file watching for ${dirPath}`);
        const conservativeOptions = {
            ...options,
            usePolling: true, // Force polling to prevent EMFILE
            interval: 3000, // Poll every 3 seconds
            depth: 1, // Only watch top level
            ignored: [
                '**/node_modules/**',
                '**/.git/**',
                '**/dist/**',
                '**/build/**',
                '**/.cache/**'
            ]
        };
        await fileWatcherService.watchDirectory(dirPath, conservativeOptions);
        // MEMORY LEAK FIX: Store listener references for proper cleanup
        const fileChangeHandler = (data) => {
            const windows = BrowserWindow.getAllWindows();
            windows.forEach(window => {
                if (!window.isDestroyed()) {
                    window.webContents.send('file:change', data);
                }
            });
        };
        const batchChangeHandler = (data) => {
            const windows = BrowserWindow.getAllWindows();
            windows.forEach(window => {
                if (!window.isDestroyed()) {
                    window.webContents.send('batch:change', data);
                }
            });
        };
        // Remove any existing listeners to prevent accumulation
        fileWatcherService.removeAllListeners('file:change');
        fileWatcherService.removeAllListeners('batch:change');
        // Add new listeners
        fileWatcherService.on('file:change', fileChangeHandler);
        fileWatcherService.on('batch:change', batchChangeHandler);
        return { success: true };
    }
    catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
});
ipcMain.handle('fileWatcher:stop', async (event, dirPath) => {
    try {
        await fileWatcherService.unwatchDirectory(dirPath);
        return { success: true };
    }
    catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
});
ipcMain.handle('fileWatcher:indexFile', async (event, filePath) => {
    try {
        const result = await fileWatcherService.performIncrementalIndex(filePath, 'change');
        return { success: true, data: result };
    }
    catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
});
// GRACEFUL FALLBACK: IPC handlers for fallback mode
ipcMain.handle('fileWatcher:getFallbackStatus', async (event) => {
    try {
        const status = fileWatcherService.getFallbackStatus();
        return { success: true, data: status };
    }
    catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
});
ipcMain.handle('fileWatcher:resetFallback', async (event) => {
    try {
        fileWatcherService.resetFallbackMode();
        return { success: true };
    }
    catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
});
// MANUAL REFRESH: IPC handlers for manual file system refresh
ipcMain.handle('fileWatcher:manualRefresh', async (event, dirPath) => {
    try {
        const result = await fileWatcherService.manualRefresh(dirPath);
        return { success: true, data: result };
    }
    catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
});
ipcMain.handle('fileWatcher:manualRefreshAll', async (event) => {
    try {
        const results = await fileWatcherService.manualRefreshAll();
        return { success: true, data: results };
    }
    catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
});
// USER SETTINGS: IPC handlers for file watching configuration
ipcMain.handle('fileWatcher:getConfiguration', async (event) => {
    try {
        const config = fileWatcherService.getWatchingConfiguration();
        return { success: true, data: config };
    }
    catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
});
ipcMain.handle('fileWatcher:setConfiguration', async (event, config) => {
    try {
        fileWatcherService.setWatchingConfiguration(config);
        return { success: true };
    }
    catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
});
ipcMain.handle('fileWatcher:getStats', () => {
    try {
        const stats = fileWatcherService.getStatistics();
        return { success: true, stats };
    }
    catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
});
// Knowledge Cache operations
ipcMain.handle('knowledgeCache:recordQuery', async (event, workspacePath, metrics) => {
    try {
        let cache = knowledgeCaches.get(workspacePath);
        if (!cache) {
            cache = createKnowledgeCache(workspacePath);
            knowledgeCaches.set(workspacePath, cache);
        }
        await cache.learnFromQuery(metrics.query, metrics.result || {}, metrics.responseTime, metrics.success);
        return { success: true };
    }
    catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
});
ipcMain.handle('knowledgeCache:getStats', async (event, workspacePath) => {
    try {
        let cache = knowledgeCaches.get(workspacePath);
        if (!cache) {
            cache = createKnowledgeCache(workspacePath);
            knowledgeCaches.set(workspacePath, cache);
        }
        const stats = cache.getStatistics();
        return { success: true, stats };
    }
    catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
});
ipcMain.handle('knowledgeCache:predict', async (event, workspacePath, context) => {
    try {
        let cache = knowledgeCaches.get(workspacePath);
        if (!cache) {
            cache = createKnowledgeCache(workspacePath);
            knowledgeCaches.set(workspacePath, cache);
        }
        const predictions = await cache.predictNextQueries(context);
        return { success: true, predictions };
    }
    catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
});
ipcMain.handle('knowledgeCache:clear', async (event, workspacePath) => {
    try {
        let cache = knowledgeCaches.get(workspacePath);
        if (!cache) {
            cache = createKnowledgeCache(workspacePath);
            knowledgeCaches.set(workspacePath, cache);
        }
        await cache.clear();
        return { success: true };
    }
    catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
});
ipcMain.handle('knowledgeCache:invalidate', async (event, workspacePath, pattern, tags) => {
    try {
        let cache = knowledgeCaches.get(workspacePath);
        if (!cache) {
            cache = createKnowledgeCache(workspacePath);
            knowledgeCaches.set(workspacePath, cache);
        }
        const count = await cache.invalidate(pattern, tags);
        return { success: true, count };
    }
    catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
});
// File System operations
ipcMain.handle('fs:readFile', async (event, filePath) => {
    const fs = await import('fs/promises');
    try {
        const content = await fs.readFile(filePath, 'utf-8');
        return { success: true, content };
    }
    catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
});
ipcMain.handle('fs:exists', async (event, filePath) => {
    const fs = await import('fs/promises');
    try {
        await fs.access(filePath);
        return true;
    }
    catch {
        return false;
    }
});
ipcMain.handle('fs:ensureDir', async (event, dirPath) => {
    try {
        await mkdir(dirPath, { recursive: true });
        return { success: true };
    }
    catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
});
ipcMain.handle('fs:rename', async (event, oldPath, newPath) => {
    const fs = await import('fs/promises');
    try {
        await fs.rename(oldPath, newPath);
        return { success: true };
    }
    catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
});
ipcMain.handle('fs:delete', async (event, filePath) => {
    const fs = await import('fs/promises');
    try {
        const stats = await fs.stat(filePath);
        if (stats.isDirectory()) {
            await fs.rmdir(filePath, { recursive: true });
        }
        else {
            await fs.unlink(filePath);
        }
        return { success: true };
    }
    catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
});
ipcMain.handle('fs:writeFile', async (event, filePath, content) => {
    const fs = await import('fs/promises');
    try {
        await fs.writeFile(filePath, content, 'utf-8');
        return { success: true };
    }
    catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
});
ipcMain.handle('fs:readDir', async (event, dirPath) => {
    const fs = await import('fs/promises');
    try {
        const entries = await fs.readdir(dirPath, { withFileTypes: true });
        const files = entries.map(entry => ({
            name: entry.name,
            path: join(dirPath, entry.name),
            isDirectory: entry.isDirectory()
        }));
        return { success: true, files };
    }
    catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
});
// Storage operations
ipcMain.handle('store:get', (event, key) => {
    return store.get(key);
});
ipcMain.handle('store:set', (event, key, value) => {
    store.set(key, value);
    return { success: true };
});
ipcMain.handle('store:delete', (event, key) => {
    store.delete(key);
    return { success: true };
});
ipcMain.handle('store:getAll', () => {
    return store.store;
});
ipcMain.handle('store:getHomePath', () => {
    return app.getPath('home');
});
// Session operations
ipcMain.handle('claude:listSessions', async () => {
    try {
        // For now, return mock data. In a real implementation, this would read from session storage
        return {
            success: true,
            sessions: [
                {
                    id: 'session-1',
                    name: 'Previous Session',
                    timestamp: new Date(Date.now() - 3600000).toISOString(),
                    messageCount: 15,
                    duration: 1800000,
                    preview: 'Working on implementing the context system...'
                },
                {
                    id: 'session-2',
                    name: 'Older Session',
                    timestamp: new Date(Date.now() - 86400000).toISOString(),
                    messageCount: 25,
                    duration: 3600000,
                    preview: 'Fixed the memory issue with the knowledge base...'
                }
            ]
        };
    }
    catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
});
ipcMain.handle('claude:resumeSession', async (event, instanceId, sessionId) => {
    try {
        // For now, just return success. In a real implementation, this would restore the session
        return { success: true };
    }
    catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
});
// Hook operations
ipcMain.handle('claude:getHooks', async () => {
    try {
        // Return hooks from Claude's settings file
        const hooks = await claudeSettingsManager.getHooks();
        return { success: true, hooks };
    }
    catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
});
ipcMain.handle('claude:addHook', async (event, hook) => {
    try {
        const existingHooks = await claudeSettingsManager.getHooks();
        const newHook = {
            ...hook,
            id: `hook_${Date.now()}`,
            disabled: hook.disabled !== undefined ? hook.disabled : false
        };
        existingHooks.push(newHook);
        await claudeSettingsManager.saveHooks(existingHooks);
        return { success: true, hook: newHook };
    }
    catch (error) {
        console.error('Error in claude:addHook:', error);
        return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
});
ipcMain.handle('claude:updateHook', async (event, hookId, updates) => {
    try {
        const hooks = await claudeSettingsManager.getHooks();
        const index = hooks.findIndex((h) => h.id === hookId);
        if (index !== -1) {
            hooks[index] = { ...hooks[index], ...updates };
            await claudeSettingsManager.saveHooks(hooks);
            return { success: true };
        }
        return { success: false, error: 'Hook not found' };
    }
    catch (error) {
        console.error('Error in claude:updateHook:', error);
        return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
});
// Add removeHook as an alias for deleteHook for compatibility
ipcMain.handle('claude:removeHook', async (event, hookId) => {
    try {
        const hooks = await claudeSettingsManager.getHooks();
        const filteredHooks = hooks.filter((h) => h.id !== hookId);
        await claudeSettingsManager.saveHooks(filteredHooks);
        return { success: true };
    }
    catch (error) {
        console.error('Error in claude:removeHook:', error);
        return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
});
ipcMain.handle('claude:deleteHook', async (event, hookId) => {
    try {
        const hooks = await claudeSettingsManager.getHooks();
        const filtered = hooks.filter((h) => h.id !== hookId);
        await claudeSettingsManager.saveHooks(filtered);
        return { success: true };
    }
    catch (error) {
        console.error('Error in claude:deleteHook:', error);
        return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
});
// Clear Claude detector cache (useful if installation changes)
ipcMain.handle('claude:clearCache', async () => {
    ClaudeDetector.clearCache();
    return { success: true };
});
// Test a hook
ipcMain.handle('claude:testHook', async (event, hook) => {
    try {
        const { exec } = await import('child_process');
        const { promisify } = await import('util');
        const execAsync = promisify(exec);
        const testCommand = claudeSettingsManager.createTestCommand(hook);
        const { stdout, stderr } = await execAsync(testCommand, {
            timeout: 5000 // 5 second timeout
        });
        return {
            success: true,
            output: stdout + (stderr ? '\n\nErrors:\n' + stderr : '')
        };
    }
    catch (error) {
        return {
            success: false,
            error: error.message || String(error),
            output: error.stdout || ''
        };
    }
});
// Open external links
ipcMain.handle('shell:openExternal', async (event, url) => {
    try {
        await shell.openExternal(url);
        return { success: true };
    }
    catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
});
// Dialog operations
ipcMain.handle('dialog:selectFolder', async () => {
    try {
        const result = await dialog.showOpenDialog(mainWindow, {
            properties: ['openDirectory'],
            title: 'Select Workspace Folder'
        });
        if (result.canceled || result.filePaths.length === 0) {
            return { success: false, canceled: true };
        }
        return { success: true, path: result.filePaths[0] };
    }
    catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
});
ipcMain.handle('dialog:selectFile', async () => {
    try {
        const result = await dialog.showOpenDialog(mainWindow, {
            properties: ['openFile'],
            title: 'Open File',
            filters: [
                { name: 'All Files', extensions: ['*'] },
                { name: 'Text Files', extensions: ['txt', 'md', 'json', 'js', 'ts', 'tsx', 'jsx', 'vue', 'css', 'scss', 'html'] }
            ]
        });
        if (result.canceled || result.filePaths.length === 0) {
            return { success: false, canceled: true };
        }
        return { success: true, path: result.filePaths[0] };
    }
    catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
});
ipcMain.handle('dialog:showOpenDialog', async (event, options) => {
    try {
        const result = await dialog.showOpenDialog(mainWindow, options);
        return result;
    }
    catch (error) {
        return { canceled: true, filePaths: [] };
    }
});
ipcMain.handle('dialog:showSaveDialog', async (event, options) => {
    try {
        const result = await dialog.showSaveDialog(mainWindow, options);
        return result;
    }
    catch (error) {
        return { canceled: true, filePath: undefined };
    }
});
ipcMain.handle('dialog:showInputBox', async (event, options) => {
    try {
        // Electron doesn't have a built-in input box, so we'll use a custom implementation
        // For now, return a simple response indicating this needs to be handled in the renderer
        return { canceled: true, value: '' };
    }
    catch (error) {
        return { canceled: true, value: '' };
    }
});
ipcMain.handle('dialog:showMessageBox', async (event, options) => {
    try {
        const result = await dialog.showMessageBox(mainWindow, options);
        return result;
    }
    catch (error) {
        return { response: 0, checkboxChecked: false };
    }
});
// Claude installation detection
ipcMain.handle('claude:detectInstallation', async () => {
    try {
        const claudeInfo = await ClaudeDetector.detectClaude();
        return { success: true, info: claudeInfo };
    }
    catch (error) {
        return { success: false };
    }
});
// File watching operations
ipcMain.handle('fs:watchFile', async (event, filePath) => {
    try {
        // Don't create duplicate watchers
        if (fileWatchers.has(filePath)) {
            return { success: true };
        }
        const watcher = chokidarWatch(filePath, {
            persistent: true,
            ignoreInitial: true,
            awaitWriteFinish: {
                stabilityThreshold: 300,
                pollInterval: 100
            }
        });
        watcher.on('change', async (path) => {
            try {
                // Read the new content immediately (chokidar already handles debouncing with awaitWriteFinish)
                const content = await readFile(filePath, 'utf-8');
                // Send update to all windows
                const windows = BrowserWindow.getAllWindows();
                windows.forEach(window => {
                    if (!window.isDestroyed()) {
                        window.webContents.send('file:changed', {
                            path: filePath,
                            content
                        });
                    }
                });
                // Also log if no windows are available
                if (windows.length === 0) {
                    console.error('[FileWatcher] No windows available to send file:changed event');
                }
            }
            catch (error) {
                console.error('[FileWatcher] Error reading changed file:', error);
            }
        });
        // Add error handler
        watcher.on('error', (error) => {
            console.error('[FileWatcher] Watcher error for', filePath, ':', error);
        });
        fileWatchers.set(filePath, watcher);
        return { success: true };
    }
    catch (error) {
        console.error('Failed to watch file:', error);
        return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
});
// Directory watching operations
ipcMain.handle('fs:watchDirectory', async (event, dirPath) => {
    try {
        // Don't create duplicate watchers
        const watchKey = `dir:${dirPath}`;
        if (fileWatchers.has(watchKey)) {
            return { success: true };
        }
        const watcher = chokidarWatch(dirPath, {
            persistent: true,
            ignoreInitial: true,
            depth: 0, // Only watch the directory itself, not subdirectories
            awaitWriteFinish: {
                stabilityThreshold: 300,
                pollInterval: 100
            }
        });
        watcher.on('all', (eventType, filePath) => {
            // Send update to renderer
            const windows = BrowserWindow.getAllWindows();
            windows.forEach(window => {
                if (!window.isDestroyed()) {
                    window.webContents.send('directory:changed', {
                        path: dirPath,
                        eventType,
                        filename: filePath
                    });
                }
            });
        });
        fileWatchers.set(watchKey, watcher);
        return { success: true };
    }
    catch (error) {
        console.error('Failed to watch directory:', error);
        return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
});
ipcMain.handle('fs:unwatchDirectory', async (event, dirPath) => {
    try {
        const watchKey = `dir:${dirPath}`;
        const watcher = fileWatchers.get(watchKey);
        if (watcher) {
            watcher.close();
            fileWatchers.delete(watchKey);
        }
        return { success: true };
    }
    catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
});
ipcMain.handle('fs:unwatchFile', async (event, filePath) => {
    try {
        const watcher = fileWatchers.get(filePath);
        if (watcher) {
            watcher.close();
            fileWatchers.delete(filePath);
        }
        return { success: true };
    }
    catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
});
// Clean up watchers on app quit
app.on('before-quit', () => {
    for (const [path, watcher] of fileWatchers) {
        watcher.close();
    }
    fileWatchers.clear();
});
// Claude SDK operations
ipcMain.handle('claude:sdk:getTodos', async (event, projectPath) => {
    try {
        const result = await claudeCodeService.getCurrentTodos(projectPath);
        return result;
    }
    catch (error) {
        console.error('Error getting todos via SDK:', error);
        return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
});
ipcMain.handle('claude:sdk:createTodos', async (event, taskDescription, projectPath) => {
    try {
        const result = await claudeCodeService.createTodosForTask(taskDescription, projectPath);
        return result;
    }
    catch (error) {
        console.error('Error creating todos via SDK:', error);
        return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
});
ipcMain.handle('claude:sdk:updateTodo', async (event, todoId, newStatus, projectPath) => {
    try {
        const result = await claudeCodeService.updateTodoStatus(todoId, newStatus, projectPath);
        return result;
    }
    catch (error) {
        console.error('Error updating todo via SDK:', error);
        return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
});
// Search operations
ipcMain.handle('search:findInFiles', async (event, options) => {
    // Add a response wrapper to ensure clean IPC communication
    const sendResponse = (data) => {
        return data;
    };
    const { promisify } = await import('util');
    const { exec } = await import('child_process');
    const execAsync = promisify(exec);
    const path = await import('path');
    const fs = await import('fs/promises');
    try {
        const { query, caseSensitive, wholeWord, useRegex, includePattern, excludePattern, workspacePath } = options;
        // Use workspace path if provided, otherwise fall back to current directory
        const workingDir = workspacePath || process.cwd();
        // Validate that the workspace path exists
        try {
            await fs.access(workingDir);
        }
        catch (error) {
            console.error('[Main] Workspace directory not found:', workingDir);
            throw new Error(`Workspace directory not found: ${workingDir}`);
        }
        try {
            // Try ripgrep first
            // Check for bundled ripgrep first
            const platform = process.platform;
            const arch = process.arch;
            const platformKey = platform === 'darwin'
                ? (arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64')
                : platform === 'linux' ? 'linux-x64'
                    : platform === 'win32' ? 'win32-x64'
                        : null;
            let rgPath = 'rg'; // Default to system rg
            if (platformKey) {
                const rgBinary = platform === 'win32' ? 'rg.exe' : 'rg';
                const bundledRgPath = path.join(__dirname, '..', 'vendor', 'ripgrep', platformKey, rgBinary);
                if (existsSync(bundledRgPath)) {
                    rgPath = bundledRgPath;
                }
                else {
                }
            }
            // Use streaming ripgrep search
            const results = await searchWithRipgrep(rgPath, query, workingDir, {
                caseSensitive,
                wholeWord,
                useRegex,
                includePattern,
                excludePattern
            });
            return sendResponse(results);
        }
        catch (error) {
            // Ripgrep failed (likely timeout), fallback to Node.js implementation
            const fallbackResults = await fallbackSearch(workingDir, options);
            return sendResponse(fallbackResults);
        }
    }
    catch (error) {
        console.error('[Main] search:findInFiles error:', error);
        if (error instanceof Error) {
            console.error('[Main] Error stack:', error.stack);
        }
        throw error;
    }
});
// Fallback search implementation using Node.js
async function fallbackSearch(workingDir, options) {
    const startTime = Date.now();
    const { query, caseSensitive, wholeWord, useRegex, includePattern, excludePattern } = options;
    const path = await import('path');
    const fs = await import('fs/promises');
    const results = new Map();
    // Build regex pattern
    let pattern = query;
    if (!useRegex) {
        pattern = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
    if (wholeWord) {
        pattern = `\\b${pattern}\\b`;
    }
    const regex = new RegExp(pattern, caseSensitive ? 'g' : 'gi');
    // Default exclude patterns
    const defaultExcludes = ['node_modules', 'dist', '.git', '.next', 'build', 'out', '.claude', '', '.worktrees', '.output', 'coverage', '.nyc_output', 'tmp', 'temp', '.cache', '.parcel-cache', '.vscode', '.idea', '__pycache__', '.DS_Store', '.nuxt'];
    const excludes = excludePattern
        ? [...defaultExcludes, ...excludePattern.split(',').map((p) => p.trim().replace('**/', '').replace('/**', ''))]
        : defaultExcludes;
    const searchInDirectory = async (dir) => {
        try {
            const entries = await fs.readdir(dir, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                // Skip excluded directories/files
                if (excludes.some(exclude => entry.name.includes(exclude) || fullPath.includes(exclude))) {
                    continue;
                }
                if (entry.isDirectory()) {
                    await searchInDirectory(fullPath);
                }
                else if (entry.isFile()) {
                    // Check include pattern
                    if (includePattern) {
                        const patterns = includePattern.split(',').map((p) => p.trim());
                        const matchesInclude = patterns.some((p) => {
                            if (p.startsWith('*.')) {
                                return entry.name.endsWith(p.substring(1));
                            }
                            return entry.name.includes(p);
                        });
                        if (!matchesInclude)
                            continue;
                    }
                    // Search in text files only
                    const ext = path.extname(entry.name).toLowerCase();
                    const textExtensions = ['.js', '.ts', '.jsx', '.tsx', '.vue', '.json', '.md', '.txt', '.css', '.scss', '.html', '.xml', '.yaml', '.yml', '.py', '.go', '.rs', '.java', '.c', '.cpp', '.h'];
                    if (!textExtensions.includes(ext))
                        continue;
                    try {
                        // Skip files larger than 5MB to prevent hanging
                        const stats = await fs.stat(fullPath);
                        if (stats.size > 5 * 1024 * 1024) {
                            continue;
                        }
                        const content = await fs.readFile(fullPath, 'utf-8');
                        const lines = content.split('\n');
                        const matches = [];
                        lines.forEach((line, lineIndex) => {
                            let match;
                            regex.lastIndex = 0; // Reset regex
                            while ((match = regex.exec(line)) !== null) {
                                matches.push({
                                    line: lineIndex + 1,
                                    column: match.index,
                                    text: line,
                                    length: match[0].length
                                });
                                if (!regex.global)
                                    break;
                            }
                        });
                        if (matches.length > 0) {
                            const relativePath = path.relative(workingDir, fullPath);
                            results.set(fullPath, {
                                path: fullPath,
                                relativePath: relativePath,
                                matches: matches
                            });
                        }
                    }
                    catch (err) {
                        // Skip files that can't be read
                    }
                }
            }
        }
        catch (err) {
            // Skip directories that can't be accessed
        }
    };
    await searchInDirectory(workingDir);
    const resultsArray = Array.from(results.values());
    return resultsArray;
}
ipcMain.handle('search:replaceInFile', async (event, options) => {
    const fs = await import('fs/promises');
    const { filePath, searchQuery, replaceQuery, line, column, caseSensitive, wholeWord, useRegex } = options;
    try {
        const content = await fs.readFile(filePath, 'utf-8');
        const lines = content.split('\n');
        if (line > 0 && line <= lines.length) {
            const lineContent = lines[line - 1];
            let pattern = searchQuery;
            if (!useRegex) {
                pattern = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            }
            if (wholeWord) {
                pattern = `\\b${pattern}\\b`;
            }
            const regex = new RegExp(pattern, caseSensitive ? 'g' : 'gi');
            lines[line - 1] = lineContent.replace(regex, replaceQuery);
            await fs.writeFile(filePath, lines.join('\n'), 'utf-8');
        }
        return { success: true };
    }
    catch (error) {
        console.error('Replace failed:', error);
        throw error;
    }
});
ipcMain.handle('search:replaceAllInFile', async (event, options) => {
    const fs = await import('fs/promises');
    const { filePath, searchQuery, replaceQuery, caseSensitive, wholeWord, useRegex } = options;
    try {
        let content = await fs.readFile(filePath, 'utf-8');
        let pattern = searchQuery;
        if (!useRegex) {
            pattern = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        }
        if (wholeWord) {
            pattern = `\\b${pattern}\\b`;
        }
        const regex = new RegExp(pattern, caseSensitive ? 'g' : 'gi');
        content = content.replace(regex, replaceQuery);
        await fs.writeFile(filePath, content, 'utf-8');
        return { success: true };
    }
    catch (error) {
        console.error('Replace all failed:', error);
        throw error;
    }
});
// Terminal operations
const terminals = new Map();
ipcMain.handle('terminal:create', async (event, options) => {
    const pty = await import('node-pty');
    const { v4: uuidv4 } = await import('uuid');
    try {
        const id = uuidv4();
        const shell = process.platform === 'win32' ? 'powershell.exe' : '/bin/bash';
        const ptyProcess = pty.spawn(shell, [], {
            name: 'xterm-color',
            cols: options.cols || 80,
            rows: options.rows || 24,
            cwd: options.cwd || process.cwd(),
            env: process.env
        });
        terminals.set(id, ptyProcess);
        ptyProcess.onData((data) => {
            mainWindow?.webContents.send(`terminal:data:${id}`, data);
            // Also forward to remote clients if in hybrid mode
            if (remoteServer) {
                remoteServer.forwardDesktopTerminalData(id, data);
            }
        });
        ptyProcess.onExit(({ exitCode, signal }) => {
            terminals.delete(id);
            mainWindow?.webContents.send(`terminal:exit:${id}`, { exitCode, signal });
        });
        return { success: true, id };
    }
    catch (error) {
        console.error('Failed to create terminal:', error);
        throw error;
    }
});
ipcMain.handle('terminal:write', async (event, id, data) => {
    const terminal = terminals.get(id);
    if (terminal) {
        terminal.write(data);
        return { success: true };
    }
    return { success: false, error: 'Terminal not found' };
});
ipcMain.handle('terminal:resize', async (event, id, cols, rows) => {
    const terminal = terminals.get(id);
    if (terminal) {
        terminal.resize(cols, rows);
        return { success: true };
    }
    return { success: false, error: 'Terminal not found' };
});
ipcMain.handle('terminal:destroy', async (event, id) => {
    const terminal = terminals.get(id);
    if (terminal) {
        terminal.kill();
        terminals.delete(id);
        return { success: true };
    }
    return { success: false, error: 'Terminal not found' };
});
// Clean up terminals on app quit
app.on('before-quit', () => {
    for (const [id, terminal] of terminals) {
        terminal.kill();
    }
    terminals.clear();
});
// Ghost text handler (for inline AI suggestions)
ipcMain.handle('autocomplete:getGhostText', async (event, { prefix, suffix, forceManual = false }) => {
    try {
        // Check if ghost text is enabled in settings (but skip check if manual trigger)
        if (!forceManual) {
            const settings = store.get('autocompleteSettings');
            // If no settings exist yet, ghost text should be disabled by default
            if (!settings || !settings.providers || !settings.providers.claude || !settings.providers.claude.enabled) {
                return { success: true, suggestion: '' }; // Return empty if disabled or settings don't exist
            }
        }
        const suggestion = await ghostTextService.getGhostTextSuggestion(prefix, suffix);
        return { success: true, suggestion };
    }
    catch (error) {
        console.error('[Main] Ghost text error:', error);
        return { success: false, suggestion: '', error: error instanceof Error ? error.message : String(error) };
    }
});
ipcMain.handle('autocomplete:initializeProject', async (event, projectPath) => {
    try {
        await ghostTextService.initializeProject(projectPath);
        return { success: true };
    }
    catch (error) {
        console.error('Ghost text project initialization error:', error);
        return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
});
// Ghost text health check
ipcMain.handle('autocomplete:checkHealth', async () => {
    try {
        return await ghostTextService.checkHealth();
    }
    catch (error) {
        console.error('Ghost text health check error:', error);
        return { available: false, status: 'error', error: error instanceof Error ? error.message : String(error) };
    }
});
// Debug: Check what settings are actually stored
ipcMain.handle('debug:getStoredSettings', async () => {
    try {
        const settings = store.get('autocompleteSettings');
        return { success: true, settings };
    }
    catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
});
ipcMain.handle('autocomplete:checkLSPServers', async () => {
    try {
        const { lspManager } = await import('./lsp-manager.js');
        const servers = await lspManager.getAvailableServers();
        return { success: true, servers };
    }
    catch (error) {
        console.error('LSP servers check error:', error);
        return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
});
ipcMain.handle('autocomplete:getLSPStatus', async () => {
    try {
        const { lspManager } = await import('./lsp-manager.js');
        const status = {
            connected: lspManager.getConnectedServers(),
            available: await lspManager.getAvailableServers()
        };
        return { success: true, status };
    }
    catch (error) {
        console.error('LSP status check error:', error);
        return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
});
// LSP Bridge handlers for codemirror-languageservice
ipcMain.handle('lsp:getCompletions', async (event, params) => {
    try {
        const { lspManager } = await import('./lsp-manager.js');
        const completions = await lspManager.getCompletions(params.filepath, params.content, params.position, params.context // Pass the full context object
        );
        // Return in LSP format expected by codemirror-languageservice
        return {
            success: true,
            completions: completions.map(item => ({
                label: item.label,
                kind: item.kind,
                detail: item.detail,
                documentation: item.documentation,
                insertText: item.insertText,
                insertTextFormat: item.insertTextFormat,
                filterText: item.filterText,
                sortText: item.sortText,
                preselect: item.preselect,
                commitCharacters: item.commitCharacters,
                additionalTextEdits: item.additionalTextEdits,
                command: item.command,
                data: item.data
            }))
        };
    }
    catch (error) {
        console.error('LSP completions error:', error);
        return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
});
ipcMain.handle('lsp:getHover', async (event, params) => {
    try {
        const { lspManager } = await import('./lsp-manager.js');
        const hover = await lspManager.getHover(params.filepath, params.content, params.position);
        if (!hover) {
            return { success: true, hover: null };
        }
        return {
            success: true,
            hover: {
                content: hover.content,
                range: hover.range
            }
        };
    }
    catch (error) {
        console.error('LSP hover error:', error);
        return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
});
ipcMain.handle('lsp:getDiagnostics', async (event, params) => {
    try {
        const { lspManager } = await import('./lsp-manager.js');
        const diagnostics = await lspManager.getDiagnostics(params.filepath, params.content);
        return {
            success: true,
            diagnostics: diagnostics || []
        };
    }
    catch (error) {
        console.error('LSP diagnostics error:', error);
        return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
});
// LSP Installation handlers
ipcMain.handle('lsp:install', async (event, params) => {
    try {
        const { id, command, packageManager } = params;
        return new Promise((resolve) => {
            // Parse the command into executable and arguments
            const commandParts = command.split(' ');
            const executable = commandParts[0];
            const args = commandParts.slice(1);
            const installProcess = spawn(executable, args, {
                stdio: ['pipe', 'pipe', 'pipe'],
                shell: true
            });
            let stdout = '';
            let stderr = '';
            installProcess.stdout?.on('data', (data) => {
                stdout += data.toString();
            });
            installProcess.stderr?.on('data', (data) => {
                stderr += data.toString();
            });
            installProcess.on('close', (code) => {
                if (code === 0) {
                    resolve({ success: true, output: stdout });
                }
                else {
                    console.error(`Failed to install LSP server: ${id}`, stderr);
                    resolve({
                        success: false,
                        error: `Installation failed with code ${code}: ${stderr || 'Unknown error'}`
                    });
                }
            });
            installProcess.on('error', (error) => {
                console.error(`Error installing LSP server: ${id}`, error);
                resolve({
                    success: false,
                    error: `Failed to start installation: ${error.message}`
                });
            });
            // Set timeout for installation (5 minutes)
            setTimeout(() => {
                try {
                    installProcess.kill();
                }
                catch (e) {
                    // Ignore kill errors
                }
                resolve({
                    success: false,
                    error: 'Installation timed out after 5 minutes'
                });
            }, 5 * 60 * 1000);
        });
    }
    catch (error) {
        console.error('LSP install error:', error);
        return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
});
ipcMain.handle('lsp:uninstall', async (event, params) => {
    try {
        const { id, packageManager } = params;
        // Define uninstall commands for different package managers
        const uninstallCommands = {
            npm: ['npm', 'uninstall', '-g'],
            pip: ['pip', 'uninstall', '-y'],
            brew: ['brew', 'uninstall'],
            go: ['rm', '-f'], // Go modules are in GOPATH/bin
            gem: ['gem', 'uninstall'],
            rustup: ['rustup', 'component', 'remove'],
            dotnet: ['dotnet', 'tool', 'uninstall', '-g']
        };
        // Map server IDs to package names
        const packageNames = {
            typescript: 'typescript-language-server',
            python: 'python-lsp-server',
            rust: 'rust-analyzer',
            go: `${homedir()}/go/bin/gopls`,
            vue: '@vue/language-server',
            html: 'vscode-langservers-extracted',
            php: 'intelephense',
            csharp: 'omnisharp',
            kotlin: 'kotlin-language-server',
            ruby: 'ruby-lsp',
            svelte: 'svelte-language-server',
            lua: 'lua-language-server',
            yaml: 'yaml-language-server',
            java: 'jdtls',
            cpp: 'llvm'
        };
        const command = uninstallCommands[packageManager];
        const packageName = packageNames[id];
        if (!command || !packageName) {
            return { success: false, error: `Unsupported uninstall for ${id} with ${packageManager}` };
        }
        return new Promise((resolve) => {
            const uninstallProcess = spawn(command[0], [...command.slice(1), packageName], {
                stdio: ['pipe', 'pipe', 'pipe'],
                shell: true
            });
            let stdout = '';
            let stderr = '';
            uninstallProcess.stdout?.on('data', (data) => {
                stdout += data.toString();
            });
            uninstallProcess.stderr?.on('data', (data) => {
                stderr += data.toString();
            });
            uninstallProcess.on('close', (code) => {
                if (code === 0) {
                    resolve({ success: true, output: stdout });
                }
                else {
                    console.error(`Failed to uninstall LSP server: ${id}`, stderr);
                    resolve({
                        success: false,
                        error: `Uninstallation failed with code ${code}: ${stderr || 'Unknown error'}`
                    });
                }
            });
            uninstallProcess.on('error', (error) => {
                console.error(`Error uninstalling LSP server: ${id}`, error);
                resolve({
                    success: false,
                    error: `Failed to start uninstallation: ${error.message}`
                });
            });
        });
    }
    catch (error) {
        console.error('LSP uninstall error:', error);
        return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
});
// Check if a command is available
ipcMain.handle('lsp:checkCommand', async (event, command) => {
    try {
        return new Promise((resolve) => {
            const checkProcess = spawn('which', [command], {
                stdio: ['pipe', 'pipe', 'pipe'],
                shell: true
            });
            checkProcess.on('close', (code) => {
                resolve({ available: code === 0 });
            });
            checkProcess.on('error', () => {
                resolve({ available: false });
            });
            // Timeout after 2 seconds
            setTimeout(() => {
                try {
                    checkProcess.kill();
                }
                catch (e) {
                    // Ignore kill errors
                }
                resolve({ available: false });
            }, 2000);
        });
    }
    catch (error) {
        console.error('Command check error:', error);
        return { available: false };
    }
});
// Code generation handler
ipcMain.handle('codeGeneration:generate', async (event, { prompt, fileContent, filePath, language, resources = [] }) => {
    try {
        // Import Claude SDK and detector
        const { query } = await import('@anthropic-ai/claude-code');
        const { ClaudeDetector } = await import('./claude-detector.js');
        // Detect Claude installation
        const claudeInfo = await ClaudeDetector.detectClaude();
        if (!claudeInfo || !claudeInfo.path) {
            return {
                success: false,
                error: 'Claude CLI not found. Please ensure Claude is installed.'
            };
        }
        // Load resource contents
        const loadedResources = await Promise.all(resources.map(async (resource) => {
            if (resource.type === 'file' && resource.path) {
                try {
                    const content = await readFile(resource.path, 'utf-8');
                    return { ...resource, content };
                }
                catch (error) {
                    console.error(`Failed to read resource file ${resource.path}:`, error);
                    return resource;
                }
            }
            else if (resource.type === 'knowledge' && resource.id) {
                // Load from knowledge store
                const knowledgeData = store.get('knowledgeBases');
                for (const kbName in knowledgeData) {
                    const kb = knowledgeData[kbName];
                    if (kb.entries && kb.entries[resource.id]) {
                        return { ...resource, content: kb.entries[resource.id].content };
                    }
                }
            }
            return resource;
        }));
        // Construct the system prompt for code generation
        const systemPrompt = `You are an expert code generation assistant. When given a file and a request to modify it, you must return ONLY the complete updated file contents. No explanations, no markdown code blocks, no comments about what changed - just the raw code for the entire file.

CRITICAL: Your response must be ONLY code. Do not include any text before or after the code. Do not wrap the code in markdown blocks. Do not explain what you're doing. Just output the raw code that should replace the file contents.`;
        // Build resource context
        let resourceContext = '';
        if (loadedResources.length > 0) {
            resourceContext = '\n\nReference Resources:\n';
            loadedResources.forEach((resource, index) => {
                if (resource.content) {
                    resourceContext += `\n--- Resource ${index + 1}: ${resource.name} (${resource.type}) ---\n`;
                    resourceContext += resource.content + '\n';
                }
            });
        }
        // Build the user prompt with context
        const userPrompt = `Current file: ${filePath}
Language: ${language}

Current file contents:
${fileContent}
${resourceContext}
Request: ${prompt}

Remember: Return ONLY the complete code for the file. No explanations. No markdown. Just the raw code.`;
        // Create an AbortController for timeout
        const abortController = new AbortController();
        const timeoutId = setTimeout(() => {
            abortController.abort();
        }, 60000); // 60 second timeout
        try {
            // Use Claude SDK to generate code with detected Claude path
            const response = query({
                prompt: userPrompt,
                options: {
                    abortController,
                    model: 'claude-sonnet-4-20250514', // Fast model for code generation
                    maxTurns: 1,
                    allowedTools: [],
                    customSystemPrompt: systemPrompt,
                    pathToClaudeCodeExecutable: claudeInfo.path
                }
            });
            let generatedCode = '';
            // Iterate through the response messages
            for await (const message of response) {
                if (message.type === 'assistant' && message.message?.content) {
                    // Extract text from content blocks
                    for (const block of message.message.content) {
                        if (block.type === 'text') {
                            generatedCode += block.text;
                        }
                    }
                }
                else if (message.type === 'result') {
                    break;
                }
            }
            clearTimeout(timeoutId);
            if (generatedCode) {
                // Clean the response - remove any markdown code blocks if present
                generatedCode = generatedCode.trim();
                // Remove markdown code blocks if they exist
                const codeBlockRegex = /^```[\w]*\n([\s\S]*?)\n```$/;
                const match = generatedCode.match(codeBlockRegex);
                if (match) {
                    generatedCode = match[1];
                }
                return {
                    success: true,
                    generatedCode,
                    replaceWholeFile: true
                };
            }
            else {
                return {
                    success: false,
                    error: 'No response from Claude'
                };
            }
        }
        catch (queryError) {
            clearTimeout(timeoutId);
            if (queryError instanceof Error && queryError.name === 'AbortError') {
                return {
                    success: false,
                    error: 'Request timed out. Try a simpler request.'
                };
            }
            throw queryError;
        }
    }
    catch (error) {
        console.error('[Code Generation] Error:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error'
        };
    }
});
// Clean up Claude instances on app quit
app.on('before-quit', async () => {
    // MEMORY LEAK FIX: Clean up all event listeners first
    try {
        fileWatcherService.removeAllListeners();
        console.log('File watcher event listeners cleaned up');
    }
    catch (error) {
        console.error('Error cleaning up file watcher listeners:', error);
    }
    // Shutdown file watchers
    try {
        await fileWatcherService.stopAll();
        console.log('File watchers stopped successfully');
    }
    catch (error) {
        console.error('Failed to stop file watchers:', error);
    }
    // Shutdown LSP servers
    try {
        const { lspManager } = await import('./lsp-manager.js');
        await lspManager.shutdown();
    }
    catch (error) {
        console.error('Failed to shutdown LSP servers:', error);
    }
    // Clean up Claude instances
    for (const [instanceId, claudePty] of claudeInstances) {
        try {
            claudePty.kill();
        }
        catch (error) {
            console.error(`Failed to kill Claude instance ${instanceId}:`, error);
        }
    }
    claudeInstances.clear();
});
// MCP (Model Context Protocol) Management - Using Claude CLI
ipcMain.handle('mcp:list', async (event, workspacePath) => {
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);
    try {
        // Get workspace path from store if not provided
        if (!workspacePath) {
            workspacePath = store.get('workspacePath') || process.cwd();
        }
        // Detect Claude to use the correct binary
        const claudeInfo = await ClaudeDetector.detectClaude(workspacePath);
        // Get the properly formatted command for running Claude with arguments
        const { command, args, useShell } = ClaudeDetector.getClaudeCommand(claudeInfo, ['mcp', 'list']);
        // Build the full command string - when using shell, args[1] contains the actual command
        let fullCommand;
        if (useShell && args[0] === '-c') {
            // The command is already properly formatted in args[1]
            fullCommand = args[1];
        }
        else {
            // Direct command execution
            fullCommand = `"${command}" ${args.map(arg => `"${arg}"`).join(' ')}`;
        }
        const { stdout } = await execAsync(fullCommand, {
            cwd: workspacePath,
            env: process.env,
            timeout: 5000 // 5 second timeout
        });
        // Parse the text output
        const lines = stdout.trim().split('\n');
        const servers = [];
        // Skip the "No MCP servers configured" message
        if (stdout.includes('No MCP servers configured')) {
            return { success: true, servers: [] };
        }
        for (const line of lines) {
            if (line.includes(':')) {
                // Parse lines like "context7: https://mcp.context7.com/mcp" or "context7: https://mcp.context7.com/mcp (HTTP)"
                const colonIndex = line.indexOf(':');
                const name = line.substring(0, colonIndex).trim();
                const rest = line.substring(colonIndex + 1).trim();
                // Check if transport type is specified in parentheses
                const parenIndex = rest.lastIndexOf('(');
                let url = rest;
                let transport = 'stdio'; // default
                if (parenIndex > -1) {
                    url = rest.substring(0, parenIndex).trim();
                    transport = rest.substring(parenIndex + 1, rest.length - 1).trim().toLowerCase();
                }
                else {
                    // Infer transport from URL
                    if (url.startsWith('http://') || url.startsWith('https://')) {
                        transport = 'http';
                    }
                }
                servers.push({
                    name,
                    url: url.trim(),
                    transport: transport === 'http' || transport === 'sse' ? transport : 'stdio'
                });
            }
        }
        return { success: true, servers };
    }
    catch (error) {
        // Check if it's a timeout error
        if (error.code === 'ETIMEDOUT' || error.signal === 'SIGTERM' || error.killed) {
            console.warn('MCP list command timed out - Claude CLI may not be responding');
            return {
                success: true,
                servers: [],
                warning: 'Claude CLI timed out - no MCP servers detected'
            };
        }
        // Check if it was interrupted (SIGINT)
        if (error.signal === 'SIGINT') {
            console.warn('MCP list command was interrupted');
            return {
                success: true,
                servers: [],
                warning: 'Command interrupted'
            };
        }
        // Check if Claude CLI is not properly configured
        if (error.code === 127) {
            console.warn('Claude CLI not found or not properly configured');
            return {
                success: true,
                servers: [],
                warning: 'Claude CLI not available'
            };
        }
        console.error('Failed to list MCP servers:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to list servers'
        };
    }
});
ipcMain.handle('mcp:add', async (event, config) => {
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);
    try {
        // Get workspace path from store
        const workspacePath = store.get('workspacePath') || process.cwd();
        // Detect Claude to use the correct binary
        const claudeInfo = await ClaudeDetector.detectClaude(workspacePath);
        const claudeCommand = claudeInfo.path;
        // Build the command with proper transport flag
        let command = `${claudeCommand} mcp add`;
        // Add transport type
        command += ` --transport ${config.type}`;
        // Add the name
        command += ` "${config.name}"`;
        // Add environment variables BEFORE the command (they're options for claude mcp add)
        if (config.env) {
            for (const [key, value] of Object.entries(config.env)) {
                command += ` -e "${key}=${value}"`;
            }
        }
        // Add headers for SSE/HTTP servers BEFORE the command
        if (config.headers && (config.type === 'sse' || config.type === 'http')) {
            for (const [key, value] of Object.entries(config.headers)) {
                command += ` -H "${key}: ${value}"`;
            }
        }
        // Add -- to stop option parsing, then add the command/URL based on type
        if (config.type === 'stdio') {
            command += ` -- "${config.command}"`;
            if (config.args && config.args.length > 0) {
                // Pass each argument separately
                command += ` ${config.args.map((arg) => `"${arg}"`).join(' ')}`;
            }
        }
        else if (config.type === 'sse' || config.type === 'http') {
            // For HTTP/SSE servers, the URL is the command argument
            command += ` -- "${config.url}"`;
        }
        const { stdout, stderr } = await execAsync(command, {
            cwd: workspacePath,
            env: process.env
        });
        if (stderr && !stdout) {
            return { success: false, error: stderr };
        }
        return { success: true };
    }
    catch (error) {
        console.error('Failed to add MCP server:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to add server'
        };
    }
});
ipcMain.handle('mcp:remove', async (event, name) => {
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);
    try {
        // Get workspace path from store
        const workspacePath = store.get('workspacePath') || process.cwd();
        // Detect Claude to use the correct binary
        const claudeInfo = await ClaudeDetector.detectClaude(workspacePath);
        const claudeCommand = claudeInfo.path;
        const { stdout, stderr } = await execAsync(`${claudeCommand} mcp remove "${name}"`, {
            cwd: workspacePath,
            env: process.env
        });
        if (stderr && !stdout) {
            return { success: false, error: stderr };
        }
        return { success: true };
    }
    catch (error) {
        console.error('Failed to remove MCP server:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to remove server'
        };
    }
});
ipcMain.handle('mcp:get', async (event, name) => {
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);
    try {
        // Get workspace path from store
        const workspacePath = store.get('workspacePath') || process.cwd();
        // Detect Claude to use the correct binary
        const claudeInfo = await ClaudeDetector.detectClaude(workspacePath);
        const claudeCommand = claudeInfo.path;
        const { stdout } = await execAsync(`${claudeCommand} mcp get "${name}"`, {
            cwd: workspacePath,
            env: process.env
        });
        // Parse the text output to extract server details
        const server = { name };
        const lines = stdout.trim().split('\n');
        for (const line of lines) {
            if (line.includes('Type:')) {
                server.transport = line.split(':')[1].trim().toLowerCase();
            }
            else if (line.includes('URL:')) {
                server.url = line.split('URL:')[1].trim();
            }
            else if (line.includes('Command:')) {
                server.command = line.split('Command:')[1].trim();
            }
        }
        return { success: true, server };
    }
    catch (error) {
        console.error('Failed to get MCP server details:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to get server details'
        };
    }
});
// Test MCP connection by trying to add and immediately remove
ipcMain.handle('mcp:test', async (event, config) => {
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);
    try {
        // For HTTP/SSE servers, test the URL directly
        if (config.type === 'sse' || config.type === 'http') {
            const https = await import('https');
            const http = await import('http');
            const url = new URL(config.url);
            const client = url.protocol === 'https:' ? https : http;
            return new Promise((resolve) => {
                const req = client.request(config.url, { method: 'HEAD', timeout: 5000 }, (res) => {
                    resolve({ success: res.statusCode !== undefined && res.statusCode < 500 });
                });
                req.on('error', (error) => {
                    resolve({
                        success: false,
                        error: `Connection failed: ${error.message}`
                    });
                });
                req.on('timeout', () => {
                    req.destroy();
                    resolve({ success: false, error: 'Connection timed out' });
                });
                req.end();
            });
        }
        // For stdio servers, test if command exists
        if (config.type === 'stdio') {
            const { stdout, stderr } = await execAsync(`which "${config.command}"`, {
                env: process.env
            });
            if (stdout.trim()) {
                return { success: true };
            }
            else {
                return { success: false, error: 'Command not found' };
            }
        }
        return { success: false, error: 'Unknown server type' };
    }
    catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Test failed'
        };
    }
});
// Lightweight Context Handlers
ipcMain.handle('context:initialize', async (event, workspacePath) => {
    try {
        const context = await workspaceContextManager.getOrCreateContext(workspacePath);
        // Set up file change notifications to frontend for this workspace
        context.onFileChange((eventType, filePath) => {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('context:file-changed', { event: eventType, filePath });
            }
        });
        return { success: true };
    }
    catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to initialize context'
        };
    }
});
ipcMain.handle('context:searchFiles', async (event, query, limit = 20) => {
    try {
        const context = workspaceContextManager.getCurrentContext();
        if (!context) {
            return { success: false, error: 'No workspace context available' };
        }
        const results = await context.searchFiles(query, limit);
        return { success: true, results };
    }
    catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to search files'
        };
    }
});
ipcMain.handle('context:buildContext', async (event, query, workingFiles, maxTokens = 2000) => {
    try {
        const contextInstance = workspaceContextManager.getCurrentContext();
        if (!contextInstance) {
            return { success: false, error: 'No workspace context available' };
        }
        const context = await contextInstance.buildContext(query, workingFiles, maxTokens);
        return { success: true, context };
    }
    catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to build context'
        };
    }
});
ipcMain.handle('context:getStatistics', async (event) => {
    try {
        const context = workspaceContextManager.getCurrentContext();
        if (!context) {
            return { success: false, error: 'No workspace context available' };
        }
        const statistics = context.getStatistics();
        return { success: true, statistics };
    }
    catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to get statistics'
        };
    }
});
ipcMain.handle('context:getFileContent', async (event, filePath) => {
    try {
        const context = workspaceContextManager.getCurrentContext();
        if (!context) {
            return { success: false, error: 'No workspace context available' };
        }
        const content = await context.getFileContent(filePath);
        return { success: true, content };
    }
    catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to get file content'
        };
    }
});
ipcMain.handle('context:getRecentFiles', async (event, hours = 24) => {
    try {
        const context = workspaceContextManager.getCurrentContext();
        if (!context) {
            return { success: false, error: 'No workspace context available' };
        }
        const files = context.getRecentFiles(hours);
        return { success: true, files };
    }
    catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to get recent files'
        };
    }
});
ipcMain.handle('context:rescan', async (event) => {
    try {
        const context = workspaceContextManager.getCurrentContext();
        if (!context) {
            return { success: false, error: 'No workspace context available' };
        }
        await context.scanWorkspace();
        return { success: true };
    }
    catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to rescan workspace'
        };
    }
});
ipcMain.handle('context:startWatching', async (event) => {
    try {
        const context = workspaceContextManager.getCurrentContext();
        if (!context) {
            return { success: false, error: 'No workspace context available' };
        }
        context.startWatching();
        return { success: true };
    }
    catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to start file watching'
        };
    }
});
ipcMain.handle('context:stopWatching', async (event) => {
    try {
        const context = workspaceContextManager.getCurrentContext();
        if (!context) {
            return { success: false, error: 'No workspace context available' };
        }
        context.stopWatching();
        return { success: true };
    }
    catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to stop file watching'
        };
    }
});
// Memory leak detection and monitoring handlers
ipcMain.handle('context:detectMemoryLeaks', async (event) => {
    try {
        const context = workspaceContextManager.getCurrentContext();
        if (!context) {
            return { success: false, error: 'No workspace context available' };
        }
        const leakReport = context.detectMemoryLeaks();
        return { success: true, leakReport };
    }
    catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to detect memory leaks'
        };
    }
});
ipcMain.handle('context:getMemoryStats', async (event) => {
    try {
        const context = workspaceContextManager.getCurrentContext();
        if (!context) {
            return { success: false, error: 'No workspace context available' };
        }
        const memoryStats = context.getMemoryStats();
        const managerStats = workspaceContextManager.getStats();
        return {
            success: true,
            memoryStats,
            managerStats
        };
    }
    catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to get memory stats'
        };
    }
});
ipcMain.handle('context:forceCleanup', async (event) => {
    try {
        const context = workspaceContextManager.getCurrentContext();
        if (!context) {
            return { success: false, error: 'No workspace context available' };
        }
        const removedCount = context.forceCleanup();
        return { success: true, removedCount };
    }
    catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to force cleanup'
        };
    }
});
// Set up file change notifications to frontend - handled by individual contexts now
// This will be set up when workspaces are initialized
// Context optimization handlers
ipcMain.handle('context:analyzeUsage', async (event, messages, currentContext) => {
    try {
        const analysis = contextOptimizer.analyzeContextUsage(messages, currentContext);
        return { success: true, analysis };
    }
    catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to analyze context usage'
        };
    }
});
ipcMain.handle('context:buildOptimized', async (event, query, workingFiles, maxTokens) => {
    try {
        const result = await contextOptimizer.buildOptimizedContext(query, workingFiles, maxTokens);
        return { success: true, ...result };
    }
    catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to build optimized context'
        };
    }
});
ipcMain.handle('context:optimize', async (event, content, strategy) => {
    try {
        const result = contextOptimizer.optimizeContext(content, strategy);
        return { success: true, result };
    }
    catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to optimize context'
        };
    }
});
ipcMain.handle('context:getRecommendations', async (event, usage) => {
    try {
        const recommendations = contextOptimizer.getOptimizationRecommendations(usage);
        return { success: true, recommendations };
    }
    catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to get recommendations'
        };
    }
});
ipcMain.handle('context:shouldInject', async (event, query, availableTokens, contextSize) => {
    try {
        const decision = contextOptimizer.shouldInjectContext(query, availableTokens, contextSize);
        return { success: true, decision };
    }
    catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to evaluate context injection'
        };
    }
});
// Workspace persistence handlers
ipcMain.handle('workspace:loadContext', async (event, workspacePath) => {
    try {
        const data = await workspacePersistence.loadWorkspaceContext(workspacePath);
        return { success: true, data };
    }
    catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to load workspace context'
        };
    }
});
ipcMain.handle('workspace:saveContext', async (event, data) => {
    try {
        await workspacePersistence.saveWorkspaceContext(data);
        return { success: true };
    }
    catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to save workspace context'
        };
    }
});
ipcMain.handle('workspace:updateOptimizationTime', async (event, workspacePath, lastOptimization) => {
    try {
        await workspacePersistence.updateOptimizationTime(workspacePath, lastOptimization);
        return { success: true };
    }
    catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to update optimization time'
        };
    }
});
ipcMain.handle('workspace:updateWorkingFiles', async (event, workspacePath, workingFiles) => {
    try {
        await workspacePersistence.updateWorkingFiles(workspacePath, workingFiles);
        return { success: true };
    }
    catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to update working files'
        };
    }
});
ipcMain.handle('workspace:getRecentHistory', async (event, workspacePath, limit) => {
    try {
        const history = await workspacePersistence.getRecentContextHistory(workspacePath, limit);
        return { success: true, history };
    }
    catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to get recent history'
        };
    }
});
ipcMain.handle('workspace:exportContext', async (event, workspacePath) => {
    try {
        const jsonData = await workspacePersistence.exportWorkspaceContext(workspacePath);
        return { success: true, data: jsonData };
    }
    catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to export workspace context'
        };
    }
});
ipcMain.handle('workspace:importContext', async (event, workspacePath, jsonData) => {
    try {
        await workspacePersistence.importWorkspaceContext(workspacePath, jsonData);
        return { success: true };
    }
    catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to import workspace context'
        };
    }
});
// Current active services
let currentWorktreeManager = null;
// let currentGitHooksManager: GitHooksManager | null = null; - now handled by GitHooksManagerGlobal
// Get current workspace path
ipcMain.handle('workspace:getCurrentPath', async () => {
    return store.get('workspacePath') || process.cwd();
});
// Git service initialization when workspace changes
ipcMain.handle('workspace:setPath', async (event, workspacePath) => {
    try {
        // Store the workspace path
        store.set('workspacePath', workspacePath);
        try {
            // Update the Git Service Manager with the new workspace
            const gitServiceManager = GitServiceManager.getInstance();
            gitServiceManager.setWorkspace(workspacePath);
        }
        catch (error) {
            console.error('[Main] Error updating GitServiceManager:', error);
        }
        try {
            // Update the Worktree Manager with the new workspace
            const worktreeManagerGlobal = WorktreeManagerGlobal.getInstance();
            const result = worktreeManagerGlobal.setWorkspace(workspacePath);
        }
        catch (error) {
            console.error('[Main] Error updating WorktreeManagerGlobal:', error);
        }
        try {
            // Update the Git Hooks Manager with the new workspace
            const gitHooksManagerGlobal = GitHooksManagerGlobal.getInstance();
            const result = gitHooksManagerGlobal.setWorkspace(workspacePath);
        }
        catch (error) {
            console.error('[Main] Error updating GitHooksManagerGlobal:', error);
        }
        // Initialize snapshot service for workspace
        // IMPORTANT: Always use the main repository path for snapshots, not worktree paths
        let snapshotProjectPath = workspacePath;
        // Check if this is a worktree path (contains .worktrees in the path)
        if (workspacePath.includes('.worktrees')) {
            // Extract the main repo path (everything before .worktrees)
            const worktreeIndex = workspacePath.indexOf('.worktrees');
            snapshotProjectPath = workspacePath.substring(0, worktreeIndex - 1); // -1 to remove the trailing slash
        }
        if (!snapshotServices.has(snapshotProjectPath)) {
            const snapshotService = new SnapshotService(snapshotProjectPath);
            snapshotService.setupIpcHandlers();
            snapshotServices.set(snapshotProjectPath, snapshotService);
        }
        return { success: true };
    }
    catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to set workspace path'
        };
    }
});
// Check if a path is ignored by git
ipcMain.handle('git:checkIgnore', async (event, workspacePath, paths) => {
    try {
        const git = await import('simple-git');
        const gitInstance = git.default(workspacePath);
        // First check if this is a git repository
        try {
            const isRepo = await gitInstance.checkIsRepo();
            if (!isRepo) {
                // Not a git repo, return all paths as not ignored
                const results = {};
                paths.forEach(path => { results[path] = false; });
                return { success: true, results, isGitRepo: false };
            }
        }
        catch (error) {
            // Git command might not be available
            const results = {};
            paths.forEach(path => { results[path] = false; });
            return { success: true, results, gitAvailable: false };
        }
        const results = {};
        for (const path of paths) {
            try {
                await gitInstance.raw(['check-ignore', path]);
                // If check-ignore returns 0 (no error), the path is ignored
                results[path] = true;
            }
            catch (error) {
                // If check-ignore returns non-zero, the path is not ignored
                results[path] = false;
            }
        }
        return { success: true, results, isGitRepo: true, gitAvailable: true };
    }
    catch (error) {
        // Return safe defaults if git is not available
        const results = {};
        paths.forEach(path => { results[path] = false; });
        return { success: true, results, gitAvailable: false };
    }
});
// Mode and remote server status
ipcMain.handle('app:getMode', async () => {
    return {
        mode: modeManager.getMode(),
        config: modeManager.getConfig(),
        remoteServerRunning: remoteServer?.isRunning() || false,
        remoteConnections: remoteServer?.getActiveConnectionCount() || 0
    };
});
// App status (same as getMode but following the naming convention)
ipcMain.handle('app:status', async () => {
    return {
        mode: modeManager.getMode(),
        config: modeManager.getConfig(),
        remoteServerRunning: remoteServer?.isRunning() || false,
        remoteConnections: remoteServer?.getActiveConnectionCount() || 0,
        remoteStats: remoteServer?.getStats(),
        tunnel: cloudflareTunnel?.getInfo() || null
    };
});
// Cloudflare tunnel handlers
ipcMain.handle('tunnel:getInfo', async () => {
    return cloudflareTunnel?.getInfo() || { url: '', status: 'stopped' };
});
ipcMain.handle('tunnel:start', async () => {
    if (!cloudflareTunnel) {
        cloudflareTunnel = new CloudflareTunnel();
        cloudflareTunnel.onStatusUpdated((tunnelInfo) => {
            mainWindow?.webContents.send('tunnel:status-updated', tunnelInfo);
        });
    }
    try {
        return await cloudflareTunnel.start();
    }
    catch (error) {
        return {
            url: '',
            status: 'error',
            error: error instanceof Error ? error.message : 'Unknown error'
        };
    }
});
ipcMain.handle('tunnel:stop', async () => {
    if (cloudflareTunnel) {
        cloudflareTunnel.stop();
        return { success: true };
    }
    return { success: false };
});
// Relay client handlers
ipcMain.handle('relay:getInfo', async () => {
    if (!relayClient)
        return null;
    return relayClient.getInfo();
});
ipcMain.handle('relay:connect', async () => {
    if (!relayClient) {
        relayClient = new RelayClient(process.env.RELAY_URL || 'wss://relay.clode.studio');
    }
    try {
        const info = await relayClient.connect();
        global.__relayClient = relayClient;
        return info;
    }
    catch (error) {
        return {
            error: error instanceof Error ? error.message : 'Failed to connect to relay'
        };
    }
});
ipcMain.handle('relay:disconnect', async () => {
    if (relayClient) {
        relayClient.disconnect();
    }
    return { success: true };
});
// Store token when QR code is generated
ipcMain.handle('remote:store-token', async (event, args) => {
    if (!remoteServer) {
        throw new Error('Remote server not initialized');
    }
    const { token, deviceId, deviceName, pairingCode, expiresAt } = args;
    remoteServer.storeToken(token, deviceId, deviceName, pairingCode, expiresAt);
    return { success: true };
});
// Get active remote connections
ipcMain.handle('remote:get-connections', async () => {
    if (!remoteServer) {
        return [];
    }
    return remoteServer.getConnections();
});
// Get active tokens
ipcMain.handle('remote:get-active-tokens', async () => {
    if (!remoteServer) {
        return [];
    }
    return remoteServer.getActiveTokens();
});
// Revoke a token
ipcMain.handle('remote:revoke-token', async (event, token) => {
    if (!remoteServer) {
        throw new Error('Remote server not initialized');
    }
    return remoteServer.revokeToken(token);
});
// Disconnect a specific device
ipcMain.handle('remote:disconnect-device', async (event, sessionId) => {
    if (!remoteServer) {
        throw new Error('Remote server not initialized');
    }
    return remoteServer.disconnectDevice(sessionId);
});
// Load persisted token from workspace
ipcMain.handle('remote:load-persisted-token', async () => {
    const workspacePath = store.get('workspacePath');
    if (!workspacePath)
        return null;
    const tokenFile = path.join(workspacePath, '.clode', 'remote-token.json');
    try {
        if (fs.existsSync(tokenFile)) {
            const data = fs.readFileSync(tokenFile, 'utf-8');
            return JSON.parse(data);
        }
    }
    catch (error) {
        console.error('Failed to load persisted token:', error);
    }
    return null;
});
// Persist token to workspace
ipcMain.handle('remote:persist-token', async (event, tokenData) => {
    const workspacePath = store.get('workspacePath');
    if (!workspacePath)
        return false;
    const clodeDir = path.join(workspacePath, '.clode');
    const tokenFile = path.join(clodeDir, 'remote-token.json');
    try {
        // Create .clode directory if it doesn't exist
        if (!fs.existsSync(clodeDir)) {
            fs.mkdirSync(clodeDir, { recursive: true });
        }
        // Write token data
        fs.writeFileSync(tokenFile, JSON.stringify(tokenData, null, 2));
        return true;
    }
    catch (error) {
        console.error('Failed to persist token:', error);
        return false;
    }
});
// Function to enable hybrid mode
async function enableHybridMode(selectedRelayType, customRelayUrl) {
    try {
        // Check if already in hybrid mode
        if (remoteServer && remoteServer.isRunning()) {
            return { success: true, message: 'Hybrid mode already enabled' };
        }
        // Update mode manager
        modeManager.setMode(MainProcessMode.HYBRID);
        // Get configuration
        const config = modeManager.getConfig();
        // Start remote server
        if (mainWindow) {
            remoteServer = new RemoteServer({
                config,
                mainWindow
            });
            await remoteServer.start();
            // Use selected relay type from UI, fallback to env var, then default to CLODE
            const relayType = (selectedRelayType || process.env.RELAY_TYPE || 'CLODE').toUpperCase();
            if (relayType === 'CLODE' || relayType === 'TRUE') {
                // Start Clode relay client
                if (!relayClient) {
                    // Use custom URL if provided, otherwise use env var or default
                    const relayUrl = customRelayUrl || process.env.RELAY_URL || 'wss://relay.clode.studio';
                    relayClient = new RelayClient(relayUrl);
                    relayClient.on('registered', (info) => {
                        console.log(`[Main] Clode Relay registered: ${info.url}`);
                        mainWindow?.webContents.send('relay:connected', info);
                    });
                    relayClient.on('reconnected', () => {
                        console.log('[Main] Clode Relay reconnected');
                        mainWindow?.webContents.send('relay:reconnected');
                    });
                    relayClient.on('connection_lost', () => {
                        console.log('[Main] Clode Relay connection lost');
                        mainWindow?.webContents.send('relay:disconnected');
                    });
                }
                // Connect to relay
                try {
                    const info = await relayClient.connect();
                    console.log(`[Main] Connected to Clode Relay: ${info.url}`);
                    global.__relayClient = relayClient;
                }
                catch (error) {
                    console.error('[Main] Failed to connect to Clode Relay:', error);
                    // Continue without relay - fallback to local network
                }
            }
            else if (relayType === 'CLOUDFLARE') {
                // Start Cloudflare tunnel
                if (!cloudflareTunnel) {
                    cloudflareTunnel = new CloudflareTunnel();
                }
                try {
                    const url = await cloudflareTunnel.start();
                    console.log(`[Main] Cloudflare tunnel started: ${url}`);
                    mainWindow?.webContents.send('tunnel:connected', { url });
                }
                catch (error) {
                    console.error('[Main] Failed to start Cloudflare tunnel:', error);
                }
            }
            else if (relayType === 'CUSTOM') {
                // Custom tunnel - user needs to set it up
                console.log('[Main] Custom tunnel mode - user needs to set up their own tunnel');
                mainWindow?.webContents.send('tunnel:custom', {
                    message: 'Please set up your custom tunnel to expose port 3000',
                    port: 3000
                });
            }
            else if (relayType === 'NONE') {
                // No tunnel - local network only
                console.log('[Main] No tunnel mode - local network access only');
                console.log('[Main] UI available at http://localhost:3000');
                console.log('[Main] Remote server available at http://localhost:' + config.serverPort);
                setTimeout(() => {
                    mainWindow?.webContents.send('tunnel:local-only', {
                        port: 3000,
                        serverPort: config.serverPort,
                    });
                }, 1000);
            }
            // Default: no additional setup needed
            return { success: true, message: 'Hybrid mode enabled successfully' };
        }
        else {
            return { success: false, error: 'Main window not available' };
        }
    }
    catch (error) {
        console.error('Failed to enable hybrid mode:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error'
        };
    }
}
// IPC handler for enabling hybrid mode
ipcMain.handle('remote:enable-hybrid-mode', async (event, options) => {
    // Support both old string format and new options object
    if (typeof options === 'string') {
        return enableHybridMode(options);
    }
    return enableHybridMode(options?.relayType, options?.customUrl);
});
ipcMain.handle('remote:disable-hybrid-mode', async () => {
    try {
        // Check if hybrid mode is enabled
        if (!remoteServer || !remoteServer.isRunning()) {
            return { success: true, message: 'Hybrid mode already disabled' };
        }
        // Stop remote server
        await remoteServer.stop();
        remoteServer = null;
        // Stop relay client if running
        if (relayClient && relayClient.isConnected()) {
            relayClient.disconnect();
            relayClient = null;
        }
        // Stop cloudflare tunnel if running
        if (cloudflareTunnel && cloudflareTunnel.isRunning()) {
            cloudflareTunnel.stop();
            cloudflareTunnel = null;
        }
        // Update mode manager
        modeManager.setMode(MainProcessMode.DESKTOP);
        return { success: true, message: 'Hybrid mode disabled successfully' };
    }
    catch (error) {
        console.error('Failed to disable hybrid mode:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error'
        };
    }
});
ipcMain.handle('remote:get-mode-status', async () => {
    return {
        mode: modeManager.getMode(),
        isHybrid: modeManager.isHybridMode(),
        isRemoteEnabled: modeManager.isRemoteEnabled(),
        serverRunning: remoteServer ? remoteServer.isRunning() : false,
        config: modeManager.getConfig()
    };
});
// Local Database handlers removed - SQLite not actively used
// Clean up on app quit
app.on('before-quit', async () => {
    // Stop remote server if running
    if (remoteServer && remoteServer.isRunning()) {
        await remoteServer.stop();
    }
    // Stop Cloudflare tunnel if running
    if (cloudflareTunnel && cloudflareTunnel.isRunning()) {
        cloudflareTunnel.stop();
    }
    // Database cleanup removed - SQLite not actively used
    for (const [path, service] of gitServices) {
        service.cleanup();
    }
    gitServices.clear();
});
