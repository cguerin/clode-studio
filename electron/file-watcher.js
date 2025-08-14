import { watch } from 'chokidar';
import { EventEmitter } from 'events';
import * as path from 'path';
import * as fs from 'fs/promises';
import { readdirSync } from 'fs';
// Simple debounce implementation to avoid ESM/CommonJS issues
function debounce(func, wait) {
    let timeout = null;
    return function debounced(...args) {
        if (timeout) {
            clearTimeout(timeout);
        }
        timeout = setTimeout(() => {
            func(...args);
            timeout = null;
        }, wait);
    };
}
export class FileWatcherService extends EventEmitter {
    watchers = new Map();
    fileIndex = new Map();
    changeQueue = new Map();
    processingQueue = false;
    processChangeQueueDebounced;
    maxWatchers = 25; // Reduced from 50 to be more conservative
    watcherCount = 0;
    emfileRetryAttempts = new Map();
    maxRetryAttempts = 3;
    retryDelay = 1000; // 1 second
    // GRACEFUL FALLBACK: Track directories that failed to watch
    failedDirectories = new Set();
    fallbackMode = false;
    fallbackReason = null;
    // USER SETTING: File watching configuration
    isWatchingDisabled = false;
    watchingStrategy = 'conservative';
    constructor() {
        super();
        this.processChangeQueueDebounced = debounce(this.processChangeQueue.bind(this), 500);
    }
    /**
     * Start watching a directory with workspace-aware optimizations
     */
    async watchDirectory(dirPath, options = {}) {
        // EMERGENCY: Memory leak returned - completely disable file watching again
        console.log(`[EMERGENCY] File watching DISABLED - memory leak returned, isolating source`);
        this.emit('directory:skipped', { directory: dirPath, reason: 'emergency_disabled' });
        return;
        // USER SETTING: Check if file watching is disabled
        if (!this.isWatchingEnabled()) {
            console.log(`File watching is disabled, skipping watch for ${dirPath}`);
            this.emit('directory:skipped', { directory: dirPath, reason: 'user_disabled' });
            return;
        }
        // GRACEFUL FALLBACK: Check if we can watch this directory
        if (!this.canWatchDirectory(dirPath)) {
            console.log(`Skipping watch for ${dirPath} due to previous failures or fallback mode`);
            this.emit('directory:skipped', { directory: dirPath, reason: 'fallback_mode' });
            return;
        }
        // PROACTIVE EMFILE PREVENTION: Check directory size first
        console.log(`[FileWatcher] Starting analysis for directory: ${dirPath}`);
        let stats;
        try {
            stats = this.getDirectoryStats(dirPath);
            console.log(`[FileWatcher] Directory analysis complete: ${stats.estimatedFileCount} estimated files`);
        }
        catch (error) {
            console.error(`[FileWatcher] Failed to analyze directory ${dirPath}:`, error);
            this.markDirectoryFailed(dirPath, error);
            return;
        }
        // Skip watching entirely for very large directories to prevent EMFILE
        if (stats.estimatedFileCount > 15000) {
            console.warn(`Directory too large (${stats.estimatedFileCount} files), skipping file watching for: ${dirPath}`);
            console.warn(`File watching disabled for large workspace. Use manual refresh or file operations will still work.`);
            // Create a mock watcher that doesn't actually watch anything
            this.watchers.set(dirPath, null);
            this.fileIndex.set(dirPath, new Set());
            this.watcherCount++;
            this.emit('ready', { directory: dirPath });
            return;
        }
        // Apply workspace-specific optimizations
        const workspaceOptions = this.optimizeOptionsForWorkspace(dirPath, options);
        // USER SETTING: Apply strategy-specific options
        const optimizedOptions = this.getStrategyOptions(workspaceOptions);
        // Check if we've hit the maximum number of watchers
        if (!this.watchers.has(dirPath) && this.watcherCount >= this.maxWatchers) {
            // Try to cleanup first
            await this.cleanupWatchers();
            // Check again after cleanup
            if (this.watcherCount >= this.maxWatchers) {
                console.warn(`Maximum watchers (${this.maxWatchers}) reached. Cannot watch ${dirPath}`);
                this.emit('error', {
                    directory: dirPath,
                    error: new Error(`Maximum watchers (${this.maxWatchers}) reached`)
                });
                return;
            }
        }
        // Stop existing watcher for this path
        if (this.watchers.has(dirPath)) {
            await this.unwatchDirectory(dirPath);
        }
        const defaultOptions = {
            ignored: [
                '**/node_modules/**',
                '**/.git/**',
                '**/.worktrees/**',
                '**/dist/**',
                '**/build/**',
                '**/.DS_Store',
                '**/*.log',
                '**/coverage/**',
                '**/.vscode/**',
                '**/.idea/**',
                '**/tmp/**',
                '**/temp/**',
                '**/.cache/**',
                '**/cache/**',
                '**/.nuxt/**',
                '**/.output/**',
                '**/public/**',
                '**/target/**', // Rust
                '**/bin/**',
                '**/obj/**', // .NET  
                '**/.next/**',
                '**/.svelte-kit/**',
                '**/vendor/**' // PHP
            ],
            depth: 0, // FIX: Only watch root directory, not subdirectories
            followSymlinks: false,
            usePolling: true, // DEFAULT TO POLLING to prevent EMFILE
            interval: 1000, // Poll every second
            awaitWriteFinish: {
                stabilityThreshold: 200,
                pollInterval: 100
            }
        };
        const mergedOptions = { ...defaultOptions, ...optimizedOptions };
        console.log(`Starting watcher for ${dirPath} with options:`, {
            usePolling: mergedOptions.usePolling,
            interval: mergedOptions.interval,
            depth: mergedOptions.depth
        });
        let watcher;
        try {
            watcher = watch(dirPath, {
                persistent: true,
                ignoreInitial: true, // FIX: Don't scan all 48,554 files on startup!
                ...mergedOptions
            });
        }
        catch (error) {
            if (error.code === 'EMFILE') {
                console.warn(`EMFILE on watcher creation for ${dirPath}, falling back to polling`);
                // Force polling with minimal options
                watcher = watch(dirPath, {
                    persistent: true,
                    ignoreInitial: true, // FIX: Don't scan all 48,554 files on startup!
                    usePolling: true,
                    interval: 3000,
                    depth: 0, // FIX: Only watch root, not 46,110 node_modules files
                    ignored: mergedOptions.ignored
                });
            }
            else {
                console.error(`Failed to create watcher for ${dirPath}:`, error);
                this.markDirectoryFailed(dirPath, error);
                this.emit('error', { directory: dirPath, error });
                return;
            }
        }
        // Initialize file index for this directory
        this.fileIndex.set(dirPath, new Set());
        watcher
            .on('add', (filePath, stats) => {
            this.handleFileEvent('add', dirPath, filePath, stats);
        })
            .on('change', (filePath, stats) => {
            this.handleFileEvent('change', dirPath, filePath, stats);
        })
            .on('unlink', (filePath) => {
            this.handleFileEvent('unlink', dirPath, filePath);
        })
            .on('error', (error) => {
            console.error(`Watcher error for ${dirPath}:`, error);
            // Handle EMFILE specifically with retry logic
            if (error.code === 'EMFILE') {
                this.handleEMFILEError(dirPath, error);
                return;
            }
            this.markDirectoryFailed(dirPath, error);
            this.emit('error', { directory: dirPath, error });
        })
            .on('ready', () => {
            this.emit('ready', { directory: dirPath });
        });
        this.watchers.set(dirPath, watcher);
        this.watcherCount++;
    }
    /**
     * Stop watching a directory
     */
    async unwatchDirectory(dirPath) {
        const watcher = this.watchers.get(dirPath);
        if (this.watchers.has(dirPath)) {
            if (watcher) {
                try {
                    await watcher.close();
                }
                catch (error) {
                    console.warn(`Error closing watcher for ${dirPath}:`, error);
                }
            }
            // Clean up whether watcher was real or null (for skipped large directories)
            this.watchers.delete(dirPath);
            this.fileIndex.delete(dirPath);
            this.changeQueue.delete(dirPath);
            this.emfileRetryAttempts.delete(dirPath); // Clear retry attempts
            this.watcherCount--;
        }
    }
    /**
     * Stop all watchers
     */
    async stopAll() {
        const promises = Array.from(this.watchers.keys()).map(dirPath => this.unwatchDirectory(dirPath));
        await Promise.all(promises);
    }
    /**
     * Get all watched files for a directory
     */
    getWatchedFiles(dirPath) {
        const index = this.fileIndex.get(dirPath);
        return index ? Array.from(index) : [];
    }
    /**
     * Check if a file is being watched
     */
    isWatching(filePath) {
        for (const [dirPath, files] of this.fileIndex.entries()) {
            if (files.has(filePath) || filePath.startsWith(dirPath)) {
                return true;
            }
        }
        return false;
    }
    /**
     * Handle file events
     */
    handleFileEvent(type, dirPath, filePath, stats) {
        // EMERGENCY FIX: Never process node_modules files to prevent memory leak
        if (filePath.includes('node_modules')) {
            return; // Silently ignore
        }
        const relativePath = path.relative(dirPath, filePath);
        const event = {
            type,
            path: filePath,
            relativePath,
            stats
        };
        // Update file index
        const index = this.fileIndex.get(dirPath);
        if (index) {
            if (type === 'add' || type === 'change') {
                index.add(filePath);
            }
            else if (type === 'unlink') {
                index.delete(filePath);
            }
        }
        // Add to change queue
        if (!this.changeQueue.has(dirPath)) {
            this.changeQueue.set(dirPath, []);
        }
        this.changeQueue.get(dirPath).push(event);
        // Process queue
        this.processChangeQueueDebounced();
    }
    /**
     * Process queued changes (debounced)
     */
    async processChangeQueue() {
        if (this.processingQueue)
            return;
        this.processingQueue = true;
        try {
            for (const [dirPath, events] of this.changeQueue.entries()) {
                if (events.length === 0)
                    continue;
                // Group events by file
                const fileEvents = new Map();
                for (const event of events) {
                    if (!fileEvents.has(event.path)) {
                        fileEvents.set(event.path, []);
                    }
                    fileEvents.get(event.path).push(event);
                }
                // Process each file's events
                for (const [filePath, fileEventList] of fileEvents.entries()) {
                    // Get the latest event for this file
                    const latestEvent = fileEventList[fileEventList.length - 1];
                    // Emit individual event
                    this.emit('file:change', {
                        directory: dirPath,
                        event: latestEvent
                    });
                }
                // Emit batch event
                this.emit('batch:change', {
                    directory: dirPath,
                    events: events.slice()
                });
                // Clear processed events
                this.changeQueue.set(dirPath, []);
            }
        }
        finally {
            this.processingQueue = false;
        }
    }
    /**
     * Perform incremental indexing of changed files
     */
    async performIncrementalIndex(filePath, type) {
        if (type === 'unlink') {
            // File was deleted, remove from index
            return {
                action: 'remove',
                path: filePath
            };
        }
        try {
            const stats = await fs.stat(filePath);
            if (!stats.isFile()) {
                return null;
            }
            const ext = path.extname(filePath).toLowerCase();
            const supportedExtensions = [
                '.ts', '.tsx', '.js', '.jsx', '.vue', '.py', '.java',
                '.cs', '.go', '.rs', '.cpp', '.c', '.h', '.php', '.rb',
                '.md', '.json', '.yaml', '.yml', '.xml', '.html', '.css'
            ];
            if (!supportedExtensions.includes(ext)) {
                return null;
            }
            const content = await fs.readFile(filePath, 'utf-8');
            const metadata = {
                path: filePath,
                size: stats.size,
                modified: stats.mtime,
                extension: ext,
                lines: content.split('\n').length
            };
            // Extract basic information
            const indexData = {
                action: type === 'add' ? 'add' : 'update',
                path: filePath,
                metadata,
                content: content.substring(0, 1000), // First 1000 chars for preview
                extractedInfo: this.extractFileInfo(content, ext)
            };
            return indexData;
        }
        catch (error) {
            console.error(`Error indexing file ${filePath}:`, error);
            return null;
        }
    }
    /**
     * Extract information from file content
     */
    extractFileInfo(content, extension) {
        const info = {
            imports: [],
            exports: [],
            functions: [],
            classes: [],
            interfaces: []
        };
        // Simple regex-based extraction (can be enhanced with proper parsing)
        if (['.ts', '.tsx', '.js', '.jsx'].includes(extension)) {
            // Extract imports
            const importRegex = /import\s+(?:{[^}]+}|\*\s+as\s+\w+|\w+)\s+from\s+['"]([^'"]+)['"]/g;
            let match;
            while ((match = importRegex.exec(content)) !== null) {
                info.imports.push(match[1]);
            }
            // Extract exports
            const exportRegex = /export\s+(?:default\s+)?(?:const|let|var|function|class|interface)\s+(\w+)/g;
            while ((match = exportRegex.exec(content)) !== null) {
                info.exports.push(match[1]);
            }
            // Extract functions
            const functionRegex = /(?:export\s+)?(?:async\s+)?function\s+(\w+)/g;
            while ((match = functionRegex.exec(content)) !== null) {
                info.functions.push(match[1]);
            }
            // Extract classes
            const classRegex = /(?:export\s+)?class\s+(\w+)/g;
            while ((match = classRegex.exec(content)) !== null) {
                info.classes.push(match[1]);
            }
            // Extract interfaces (TypeScript)
            if (['.ts', '.tsx'].includes(extension)) {
                const interfaceRegex = /(?:export\s+)?interface\s+(\w+)/g;
                while ((match = interfaceRegex.exec(content)) !== null) {
                    info.interfaces.push(match[1]);
                }
            }
        }
        return info;
    }
    /**
     * Get statistics about watched directories
     */
    getStatistics() {
        const stats = {
            watchedDirectories: this.watchers.size,
            watcherCount: this.watcherCount,
            maxWatchers: this.maxWatchers,
            totalFiles: 0,
            directories: {}
        };
        for (const [dirPath, files] of this.fileIndex.entries()) {
            stats.directories[dirPath] = {
                fileCount: files.size,
                files: Array.from(files)
            };
            stats.totalFiles += files.size;
        }
        return stats;
    }
    /**
     * Optimize watcher options for workspace directories
     */
    optimizeOptionsForWorkspace(dirPath, options) {
        const stats = this.getDirectoryStats(dirPath);
        console.log(`Workspace analysis for ${dirPath}: ${stats.estimatedFileCount} estimated files`);
        // For very large workspaces, use even more conservative settings
        if (stats.estimatedFileCount > 10000) {
            console.log(`Very large workspace detected, using slowest polling`);
            return {
                ...options,
                depth: 0, // FIX: Only watch root directory itself
                usePolling: true,
                interval: 3000, // Poll every 3 seconds
            };
        }
        else if (stats.estimatedFileCount > 2000) {
            console.log(`Large workspace detected, using slow polling`);
            return {
                ...options,
                depth: 0, // FIX: Only watch root directory,
                usePolling: true,
                interval: 2000, // Poll every 2 seconds
            };
        }
        // For smaller workspaces, still use polling by default but faster
        console.log(`Using standard polling for workspace`);
        return {
            ...options,
            usePolling: true,
            interval: 1000
        };
    }
    /**
     * Get basic statistics about a directory with actual counting for better accuracy
     */
    getDirectoryStats(dirPath) {
        try {
            // Quick scan of top-level directories
            const topLevelFiles = readdirSync(dirPath, { withFileTypes: true });
            let estimatedFileCount = 0;
            let actualFileCount = 0;
            let directoriesScanned = 0;
            const maxDirsToScan = 10; // Limit scanning to prevent delays
            // Count actual files at the top level
            for (const file of topLevelFiles) {
                if (file.isFile()) {
                    actualFileCount++;
                }
                else if (file.isDirectory()) {
                    const dirName = file.name.toLowerCase();
                    // For critical directories, do actual counting (limited)
                    if (directoriesScanned < maxDirsToScan &&
                        !dirName.startsWith('.') &&
                        dirName !== 'node_modules') {
                        try {
                            const subPath = path.join(dirPath, file.name);
                            const subFiles = readdirSync(subPath, { withFileTypes: true });
                            const subFileCount = subFiles.filter((f) => f.isFile()).length;
                            estimatedFileCount += subFileCount;
                            directoriesScanned++;
                            // If we find a subdirectory with many files, estimate the rest
                            if (subFileCount > 100) {
                                estimatedFileCount += (topLevelFiles.length - directoriesScanned) * 200;
                                break;
                            }
                        }
                        catch (e) {
                            // Skip directories we can't read
                            estimatedFileCount += 100;
                        }
                    }
                    else {
                        // Use heuristics for special directories
                        if (dirName === 'node_modules') {
                            // Don't count node_modules files toward the threshold - they're ignored anyway
                            // estimatedFileCount += 0;
                        }
                        else if (dirName === '.git') {
                            estimatedFileCount += 1000;
                        }
                        else if (dirName.startsWith('.')) {
                            estimatedFileCount += 50;
                        }
                        else {
                            estimatedFileCount += 200; // More conservative estimate
                        }
                    }
                }
            }
            const totalEstimate = actualFileCount + estimatedFileCount;
            console.log(`Directory stats for ${dirPath}: ${actualFileCount} top-level files, ~${totalEstimate} total estimated`);
            return { estimatedFileCount: totalEstimate };
        }
        catch (error) {
            console.warn(`Failed to scan directory ${dirPath}:`, error);
            // If we can't read the directory, assume it's medium-sized
            return { estimatedFileCount: 2000 };
        }
    }
    /**
     * Handle EMFILE errors with retry logic and aggressive cleanup
     */
    async handleEMFILEError(dirPath, error) {
        console.warn(`EMFILE error for ${dirPath}, starting recovery process`);
        // First, remove the problematic watcher
        await this.unwatchDirectory(dirPath);
        // Aggressive cleanup - remove half of all watchers
        await this.performAggressiveCleanup();
        // Track retry attempts
        const retryCount = this.emfileRetryAttempts.get(dirPath) || 0;
        if (retryCount < this.maxRetryAttempts) {
            this.emfileRetryAttempts.set(dirPath, retryCount + 1);
            console.log(`Retrying watch for ${dirPath} in ${this.retryDelay}ms (attempt ${retryCount + 1}/${this.maxRetryAttempts})`);
            // Retry after delay with more conservative options
            setTimeout(async () => {
                try {
                    await this.watchDirectory(dirPath, {
                        depth: 2, // Very limited depth for retry
                        usePolling: true, // Use polling instead of native watching
                        interval: 1000 // Poll every second
                    });
                    // Clear retry count on success
                    this.emfileRetryAttempts.delete(dirPath);
                    console.log(`Successfully restored watching for ${dirPath} using polling`);
                }
                catch (retryError) {
                    console.error(`Failed to restore watching for ${dirPath}:`, retryError);
                    this.emit('error', { directory: dirPath, error: retryError });
                }
            }, this.retryDelay);
        }
        else {
            console.error(`Max retry attempts reached for ${dirPath}, giving up`);
            this.emfileRetryAttempts.delete(dirPath);
            this.emit('error', { directory: dirPath, error });
        }
    }
    /**
     * Perform aggressive cleanup when hitting file descriptor limits
     */
    async performAggressiveCleanup() {
        console.log('Performing aggressive watcher cleanup due to EMFILE error...');
        const watcherEntries = Array.from(this.watchers.entries());
        // Remove half of all watchers, prioritizing larger/less important directories
        const toRemove = watcherEntries
            .sort((a, b) => {
            const aFiles = this.fileIndex.get(a[0])?.size || 0;
            const bFiles = this.fileIndex.get(b[0])?.size || 0;
            return bFiles - aFiles; // Sort by file count descending
        })
            .slice(0, Math.ceil(watcherEntries.length / 2));
        for (const [dirPath] of toRemove) {
            await this.unwatchDirectory(dirPath);
        }
        // Force garbage collection if available
        if (global.gc) {
            global.gc();
        }
        console.log(`Aggressively cleaned up ${toRemove.length} watchers`);
    }
    /**
     * Clean up old/unused watchers if we're approaching limits
     */
    async cleanupWatchers() {
        if (this.watcherCount < this.maxWatchers * 0.8) {
            return;
        }
        console.log('Cleaning up old watchers...');
        const watcherEntries = Array.from(this.watchers.entries());
        // Sort by some criteria (e.g., least recently used directories)
        // For now, just remove the oldest half
        const toRemove = watcherEntries.slice(0, Math.floor(watcherEntries.length / 2));
        for (const [dirPath] of toRemove) {
            await this.unwatchDirectory(dirPath);
        }
        console.log(`Cleaned up ${toRemove.length} watchers`);
    }
    /**
     * GRACEFUL FALLBACK: Enter fallback mode when file watching fails
     */
    enterFallbackMode(reason) {
        this.fallbackMode = true;
        this.fallbackReason = reason;
        console.warn(`File watching entering fallback mode: ${reason}`);
        console.warn('Manual refresh will be required for external file changes');
        // Emit fallback event for UI notifications
        this.emit('fallback:activated', { reason });
    }
    /**
     * GRACEFUL FALLBACK: Check if directory can be watched safely
     */
    canWatchDirectory(dirPath) {
        if (this.failedDirectories.has(dirPath)) {
            return false;
        }
        if (this.fallbackMode) {
            console.log(`Skipping watch for ${dirPath} - in fallback mode`);
            return false;
        }
        return true;
    }
    /**
     * GRACEFUL FALLBACK: Mark directory as failed and consider fallback mode
     */
    markDirectoryFailed(dirPath, error) {
        this.failedDirectories.add(dirPath);
        // If too many directories fail, enter global fallback mode
        if (this.failedDirectories.size >= 3) {
            this.enterFallbackMode(`Multiple directory watch failures (${this.failedDirectories.size})`);
        }
        console.warn(`Directory watch failed for ${dirPath}:`, error.message);
        this.emit('directory:failed', { directory: dirPath, error: error.message });
    }
    /**
     * GRACEFUL FALLBACK: Get fallback status
     */
    getFallbackStatus() {
        return {
            isActive: this.fallbackMode,
            reason: this.fallbackReason,
            failedDirectories: Array.from(this.failedDirectories)
        };
    }
    /**
     * GRACEFUL FALLBACK: Reset fallback mode (for user-initiated retry)
     */
    resetFallbackMode() {
        this.fallbackMode = false;
        this.fallbackReason = null;
        this.failedDirectories.clear();
        console.log('File watching fallback mode reset');
        this.emit('fallback:reset');
    }
    /**
     * MANUAL REFRESH: Force refresh of a directory's file index
     */
    async manualRefresh(dirPath) {
        console.log(`Manual refresh requested for ${dirPath}`);
        const changes = [];
        const currentIndex = this.fileIndex.get(dirPath) || new Set();
        const newFiles = new Set();
        try {
            // Recursively scan directory with limited depth to avoid performance issues
            const scanFiles = async (currentPath, depth = 0) => {
                if (depth > 3)
                    return; // Limit depth to prevent excessive scanning
                const entries = readdirSync(currentPath, { withFileTypes: true });
                for (const entry of entries) {
                    const fullPath = path.join(currentPath, entry.name);
                    const relativePath = path.relative(dirPath, fullPath);
                    // Skip ignored files
                    if (this.shouldIgnoreFile(relativePath)) {
                        continue;
                    }
                    if (entry.isFile()) {
                        newFiles.add(fullPath);
                        // Check if this is a new file
                        if (!currentIndex.has(fullPath)) {
                            changes.push({
                                type: 'add',
                                path: fullPath,
                                relativePath,
                                stats: null
                            });
                        }
                    }
                    else if (entry.isDirectory() && depth < 3) {
                        // Recursively scan subdirectories
                        await scanFiles(fullPath, depth + 1);
                    }
                }
            };
            await scanFiles(dirPath);
            // Find deleted files
            for (const filePath of currentIndex) {
                if (!newFiles.has(filePath)) {
                    const relativePath = path.relative(dirPath, filePath);
                    changes.push({
                        type: 'unlink',
                        path: filePath,
                        relativePath,
                        stats: null
                    });
                }
            }
            // Update the file index
            this.fileIndex.set(dirPath, newFiles);
            // Emit events for all changes
            for (const change of changes) {
                this.emit('file:change', { directory: dirPath, event: change });
            }
            console.log(`Manual refresh completed for ${dirPath}: ${changes.length} changes, ${newFiles.size} total files`);
            return { changes, totalFiles: newFiles.size };
        }
        catch (error) {
            console.error(`Manual refresh failed for ${dirPath}:`, error);
            throw error;
        }
    }
    /**
     * MANUAL REFRESH: Check if a file should be ignored during manual scan
     */
    shouldIgnoreFile(relativePath) {
        const ignoredPatterns = [
            'node_modules',
            '.git',
            'dist',
            'build',
            '.DS_Store',
            '*.log',
            'coverage',
            '.vscode',
            '.idea',
            'tmp',
            'temp',
            '.cache'
        ];
        return ignoredPatterns.some(pattern => {
            if (pattern.includes('*')) {
                const regex = new RegExp(pattern.replace(/\*/g, '.*'));
                return regex.test(relativePath);
            }
            return relativePath.includes(pattern);
        });
    }
    /**
     * MANUAL REFRESH: Refresh all currently watched directories
     */
    async manualRefreshAll() {
        const results = {};
        for (const dirPath of this.watchers.keys()) {
            try {
                const result = await this.manualRefresh(dirPath);
                results[dirPath] = {
                    changes: result.changes.length,
                    totalFiles: result.totalFiles
                };
            }
            catch (error) {
                console.error(`Manual refresh failed for ${dirPath}:`, error);
                results[dirPath] = { changes: -1, totalFiles: -1 }; // Indicate failure
            }
        }
        console.log(`Manual refresh completed for all directories:`, results);
        return results;
    }
    /**
     * USER SETTING: Configure file watching behavior
     */
    setWatchingConfiguration(config) {
        const previouslyDisabled = this.isWatchingDisabled;
        if (config.enabled !== undefined) {
            this.isWatchingDisabled = !config.enabled;
        }
        if (config.strategy !== undefined) {
            this.watchingStrategy = config.strategy;
        }
        console.log(`File watching configuration updated: enabled=${!this.isWatchingDisabled}, strategy=${this.watchingStrategy}`);
        // If file watching was disabled and now enabled, offer to restart watchers
        if (previouslyDisabled && !this.isWatchingDisabled) {
            this.resetFallbackMode(); // Clear any fallback state
            this.emit('configuration:changed', { enabled: true, strategy: this.watchingStrategy });
        }
        // If file watching was enabled and now disabled, stop all watchers
        if (!previouslyDisabled && this.isWatchingDisabled) {
            this.stopAll().then(() => {
                console.log('All file watchers stopped due to user configuration');
                this.emit('configuration:changed', { enabled: false, strategy: this.watchingStrategy });
            }).catch(error => {
                console.error('Error stopping watchers after disabling:', error);
            });
        }
        // If just strategy changed, emit configuration change event
        if (config.strategy !== undefined && previouslyDisabled === this.isWatchingDisabled) {
            this.emit('configuration:changed', { enabled: !this.isWatchingDisabled, strategy: this.watchingStrategy });
        }
    }
    /**
     * USER SETTING: Get current file watching configuration
     */
    getWatchingConfiguration() {
        return {
            enabled: !this.isWatchingDisabled,
            strategy: this.watchingStrategy,
            activeWatchers: this.watcherCount,
            fallbackMode: this.fallbackMode
        };
    }
    /**
     * USER SETTING: Check if file watching is enabled
     */
    isWatchingEnabled() {
        return !this.isWatchingDisabled && this.watchingStrategy !== 'disabled';
    }
    /**
     * USER SETTING: Get strategy-specific options
     */
    getStrategyOptions(baseOptions) {
        switch (this.watchingStrategy) {
            case 'aggressive':
                return {
                    ...baseOptions,
                    depth: 8,
                    usePolling: false,
                    interval: 100
                };
            case 'conservative':
                return {
                    ...baseOptions,
                    depth: 2,
                    usePolling: true,
                    interval: 1000
                };
            case 'minimal':
                return {
                    ...baseOptions,
                    depth: 0,
                    usePolling: true,
                    interval: 5000
                };
            case 'disabled':
                // Should not reach here as isWatchingEnabled would catch this
                return baseOptions;
            default:
                return baseOptions;
        }
    }
}
// Singleton instance
export const fileWatcherService = new FileWatcherService();
