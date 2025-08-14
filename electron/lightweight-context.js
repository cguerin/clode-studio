import { readdir, stat, readFile } from 'fs/promises';
import { join, extname, basename, relative } from 'path';
import { existsSync } from 'fs';
import { workspacePersistence } from './workspace-persistence.js';
import { LRUCache } from './lru-cache.js';
import { fileWatcherService } from './file-watcher.js';
export class LightweightContext {
    workspacePath = '';
    fileCache;
    projectInfo = null;
    lastScanTime = 0;
    isDestroyed = false;
    // File watching - now uses centralized watcher service
    watcherCallbacks = new Map();
    fileWatcherCleanup = null;
    callbackIdCounter = 0;
    scanDebounceTimer = null;
    // Memory management - VERY conservative limits to prevent EMFILE
    MAX_FILES = 300; // LRU cache limit - much lower to prevent EMFILE
    MAX_FILE_SIZE = 512 * 1024; // 512KB per file
    MAX_CACHE_AGE = 30 * 60 * 1000; // 30 minutes
    MEMORY_CHECK_INTERVAL = 5000; // 5 seconds
    MEMORY_THRESHOLD = 200 * 1024 * 1024; // 200MB threshold
    memoryMonitorInterval = null;
    // Common file extensions and their languages
    languageMap = {
        '.js': 'javascript',
        '.ts': 'typescript',
        '.jsx': 'javascript',
        '.tsx': 'typescript',
        '.vue': 'vue',
        '.py': 'python',
        '.java': 'java',
        '.cpp': 'cpp',
        '.c': 'c',
        '.cs': 'csharp',
        '.php': 'php',
        '.rb': 'ruby',
        '.go': 'go',
        '.rs': 'rust',
        '.swift': 'swift',
        '.kt': 'kotlin',
        '.scala': 'scala',
        '.ex': 'elixir',
        '.al': 'al',
        '.html': 'html',
        '.css': 'css',
        '.json': 'json',
        '.md': 'markdown',
        '.yaml': 'yaml',
        '.yml': 'yaml',
        '.xml': 'xml',
        '.sql': 'sql'
    };
    // Files to ignore - comprehensive list for large workspaces
    ignorePatterns = [
        // Dependencies
        'node_modules',
        'vendor',
        'packages',
        '.pnpm-store',
        // Version control
        '.git',
        '.svn',
        '.hg',
        // Claude/IDE specific
        '.claude',
        '.claude-checkpoints',
        '.clode',
        '.worktrees',
        '.vscode',
        '.idea',
        '*.swp',
        '*.swo',
        // Build outputs
        'dist',
        'build',
        'out',
        '.output',
        '.next',
        'public/build',
        'target',
        'bin',
        'obj',
        // Logs and temp files
        'logs',
        '*.log',
        'tmp',
        'temp',
        '.tmp',
        '.temp',
        // Cache directories
        '.cache',
        '.parcel-cache',
        '.nuxt',
        '.turbo',
        '.webpack',
        // Test coverage
        'coverage',
        '.nyc_output',
        '.coverage',
        'htmlcov',
        // Language specific
        '__pycache__',
        '*.pyc',
        '*.pyo',
        '*.class',
        '*.o',
        '*.so',
        '*.dll',
        '*.exe',
        // OS files
        '.DS_Store',
        'Thumbs.db',
        'desktop.ini',
        // Large media files
        '*.mp4',
        '*.avi',
        '*.mov',
        '*.wmv',
        '*.mp3',
        '*.wav',
        '*.flac',
        '*.zip',
        '*.rar',
        '*.7z',
        '*.tar.gz',
        '*.dmp',
        '*.dump'
    ];
    constructor() {
        // Initialize LRU cache with conservative limits
        this.fileCache = new LRUCache(this.MAX_FILES, this.MAX_CACHE_AGE);
    }
    async initialize(workspacePath) {
        if (this.isDestroyed) {
            throw new Error('Cannot initialize destroyed LightweightContext instance');
        }
        // Stop any existing watchers
        this.stopWatching();
        // Validate workspace path exists
        if (!workspacePath || !existsSync(workspacePath)) {
            throw new Error(`Workspace path does not exist: ${workspacePath}`);
        }
        // Validate that this isn't a parent directory containing multiple projects
        await this.validateWorkspacePath(workspacePath);
        this.workspacePath = workspacePath;
        // Load .gitignore patterns
        await this.loadGitignorePatterns();
        // Try to load persisted context first
        const persistedData = await workspacePersistence.loadWorkspaceContext(workspacePath);
        if (persistedData && persistedData.projectInfo) {
            this.projectInfo = persistedData.projectInfo;
            // Still scan to get fresh file data
        }
        await this.scanWorkspace();
        // Save the project info for future sessions
        if (this.projectInfo) {
            await workspacePersistence.updateProjectInfo(workspacePath, this.projectInfo);
        }
        // Start watching for file changes
        this.startWatching().catch(error => {
            console.warn('Failed to start file watching during initialization:', error);
        });
        // Start memory monitoring
        this.startMemoryMonitor();
    }
    async scanWorkspace() {
        if (this.isDestroyed)
            return;
        const startTime = Date.now();
        this.fileCache.clear();
        const files = await this.scanDirectory(this.workspacePath);
        // Build project info
        this.projectInfo = this.analyzeProject(files);
        this.lastScanTime = Date.now();
        console.log(`Workspace scan completed in ${Date.now() - startTime}ms, found ${files.length} files`);
    }
    async scanDirectory(dirPath, depth = 0) {
        if (depth > 8)
            return []; // Prevent infinite recursion
        if (this.isDestroyed)
            return [];
        const files = [];
        const relativePath = relative(this.workspacePath, dirPath);
        // Check if directory should be ignored
        if (this.shouldIgnore(relativePath)) {
            return files;
        }
        // Validate directory exists before scanning
        if (!existsSync(dirPath)) {
            console.warn(`Directory does not exist, skipping: ${dirPath}`);
            return files;
        }
        try {
            const entries = await readdir(dirPath);
            // Process entries in batches to avoid memory spikes
            const BATCH_SIZE = 50;
            for (let i = 0; i < entries.length; i += BATCH_SIZE) {
                if (this.isDestroyed)
                    break;
                const batch = entries.slice(i, i + BATCH_SIZE);
                const batchPromises = batch.map(async (entry) => {
                    const fullPath = join(dirPath, entry);
                    try {
                        const stats = await stat(fullPath);
                        if (stats.isDirectory()) {
                            // Recursively scan subdirectories
                            return await this.scanDirectory(fullPath, depth + 1);
                        }
                        else {
                            // Process file
                            const ext = extname(entry).toLowerCase();
                            const language = this.languageMap[ext] || 'unknown';
                            // Skip binary files and very large files
                            if (stats.size > this.MAX_FILE_SIZE || this.isBinaryFile(entry)) {
                                return [];
                            }
                            // Check file count limit to prevent memory issues
                            if (this.fileCache.size() >= this.MAX_FILES) {
                                console.warn(`File limit reached (${this.MAX_FILES}), stopping directory scan`);
                                return [];
                            }
                            const fileInfo = {
                                path: fullPath,
                                name: entry,
                                size: stats.size,
                                language,
                                lastModified: stats.mtime,
                                isDirectory: false
                            };
                            // Add to cache immediately to keep memory usage bounded
                            this.fileCache.set(fullPath, fileInfo);
                            return [fileInfo];
                        }
                    }
                    catch (error) {
                        console.warn(`Error processing entry ${fullPath}:`, error);
                        return [];
                    }
                });
                // Process batch and flatten results
                const batchResults = await Promise.all(batchPromises);
                for (const result of batchResults) {
                    files.push(...result);
                }
                // Yield control periodically to prevent blocking
                if (i + BATCH_SIZE < entries.length) {
                    await new Promise(resolve => setImmediate(resolve));
                }
            }
        }
        catch (error) {
            console.warn(`Error scanning directory ${dirPath}:`, error);
        }
        return files;
    }
    shouldIgnore(path) {
        return this.ignorePatterns.some(pattern => {
            if (pattern.includes('*')) {
                // Simple glob pattern matching
                const regex = new RegExp(pattern.replace(/\*/g, '.*'));
                return regex.test(path);
            }
            return path.includes(pattern);
        });
    }
    isBinaryFile(filename) {
        const binaryExtensions = [
            '.exe', '.dll', '.so', '.dylib', '.bin', '.dat',
            '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.ico',
            '.mp3', '.mp4', '.avi', '.mov', '.wmv',
            '.zip', '.rar', '.7z', '.tar', '.gz',
            '.pdf', '.doc', '.docx', '.xls', '.xlsx'
        ];
        const ext = extname(filename).toLowerCase();
        return binaryExtensions.includes(ext);
    }
    analyzeProject(files) {
        const languageDistribution = {};
        const languages = new Set();
        const entryPoints = [];
        const configFiles = [];
        for (const file of files) {
            // Count languages
            languageDistribution[file.language] = (languageDistribution[file.language] || 0) + 1;
            languages.add(file.language);
            // Identify entry points
            if (this.isEntryPoint(file.name)) {
                entryPoints.push(file.path);
            }
            // Identify config files
            if (this.isConfigFile(file.name)) {
                configFiles.push(file.path);
            }
        }
        return {
            type: this.detectProjectType(files),
            framework: this.detectFramework(files),
            languages: Array.from(languages),
            entryPoints,
            configFiles,
            totalFiles: files.length,
            languageDistribution
        };
    }
    isEntryPoint(filename) {
        const entryPoints = [
            'main.js', 'main.ts', 'index.js', 'index.ts',
            'app.js', 'app.ts', 'server.js', 'server.ts',
            'main.py', '__main__.py', 'app.py',
            'Main.java', 'Application.java',
            'main.cpp', 'main.c',
            'Program.cs', 'Main.cs'
        ];
        return entryPoints.includes(filename);
    }
    isConfigFile(filename) {
        const configFiles = [
            'package.json', 'tsconfig.json', 'nuxt.config.ts', 'vite.config.ts',
            'webpack.config.js', 'rollup.config.js', 'babel.config.js',
            'pom.xml', 'build.gradle', 'Cargo.toml', 'requirements.txt',
            'Dockerfile', 'docker-compose.yml', '.gitignore', 'README.md'
        ];
        return configFiles.includes(filename);
    }
    detectProjectType(files) {
        const fileNames = files.map(f => f.name);
        if (fileNames.includes('package.json'))
            return 'nodejs';
        if (fileNames.includes('pom.xml'))
            return 'java';
        if (fileNames.includes('Cargo.toml'))
            return 'rust';
        if (fileNames.includes('requirements.txt'))
            return 'python';
        if (fileNames.includes('go.mod'))
            return 'go';
        if (fileNames.includes('Gemfile'))
            return 'ruby';
        if (fileNames.includes('composer.json'))
            return 'php';
        if (fileNames.some(name => name.endsWith('.csproj')))
            return 'csharp';
        if (fileNames.some(name => name.endsWith('.vcxproj')))
            return 'cpp';
        if (fileNames.includes('app.json'))
            return 'al';
        return 'unknown';
    }
    detectFramework(files) {
        const fileNames = files.map(f => f.name);
        if (fileNames.includes('nuxt.config.ts'))
            return 'nuxt';
        if (fileNames.includes('next.config.js'))
            return 'nextjs';
        if (fileNames.includes('vue.config.js'))
            return 'vue';
        if (fileNames.includes('angular.json'))
            return 'angular';
        if (fileNames.includes('svelte.config.js'))
            return 'svelte';
        if (fileNames.includes('gatsby-config.js'))
            return 'gatsby';
        if (fileNames.includes('vite.config.ts'))
            return 'vite';
        return undefined;
    }
    async validateWorkspacePath(workspacePath) {
        try {
            const entries = await readdir(workspacePath);
            let projectLikeDirs = 0;
            // Check for multiple project-like subdirectories
            for (const entry of entries) {
                const fullPath = join(workspacePath, entry);
                const stats = await stat(fullPath);
                if (stats.isDirectory() && !this.shouldIgnore(entry)) {
                    // Check if this directory looks like a project
                    const projectFiles = ['package.json', 'pom.xml', 'Cargo.toml', 'requirements.txt',
                        'go.mod', 'Gemfile', 'composer.json', '.git'];
                    for (const projectFile of projectFiles) {
                        if (existsSync(join(fullPath, projectFile))) {
                            projectLikeDirs++;
                            break;
                        }
                    }
                }
            }
            // If we found multiple project-like directories, this might be a parent directory
            if (projectLikeDirs >= 3) {
                console.warn(`Warning: Workspace path "${workspacePath}" contains ${projectLikeDirs} project-like directories. This might cause excessive memory usage.`);
                // VERY conservative limits for multiple projects to prevent EMFILE
                this.MAX_FILES = Math.min(this.MAX_FILES, 200);
                console.warn(`Reduced MAX_FILES to ${this.MAX_FILES} to prevent EMFILE errors.`);
            }
            else if (projectLikeDirs === 1) {
                // Single large project - use VERY conservative limits to prevent EMFILE
                this.MAX_FILES = Math.min(this.MAX_FILES, 500);
                console.log(`Detected single large project, reduced MAX_FILES to ${this.MAX_FILES} to prevent EMFILE errors.`);
            }
        }
        catch (error) {
            console.warn('Failed to validate workspace path:', error);
        }
    }
    // Fast file search using simple text matching
    async searchFiles(query, limit = 20) {
        if (this.isDestroyed)
            return [];
        const results = [];
        const queryLower = query.toLowerCase();
        for (const file of this.fileCache.values()) {
            let score = 0;
            // Score based on filename match
            if (file.name.toLowerCase().includes(queryLower)) {
                score += 10;
            }
            // Score based on path match
            if (file.path.toLowerCase().includes(queryLower)) {
                score += 5;
            }
            // Score based on language match
            if (file.language.toLowerCase().includes(queryLower)) {
                score += 3;
            }
            // Boost recent files
            const daysSinceModified = (Date.now() - file.lastModified.getTime()) / (1000 * 60 * 60 * 24);
            if (daysSinceModified < 1)
                score += 5;
            else if (daysSinceModified < 7)
                score += 2;
            if (score > 0) {
                file.relevanceScore = score;
                results.push(file);
            }
        }
        return results
            .sort((a, b) => (b.relevanceScore || 0) - (a.relevanceScore || 0))
            .slice(0, limit);
    }
    // Build smart context for Claude based on query and working files
    async buildContext(query, workingFiles = [], maxTokens = 2000) {
        const context = [];
        // Add project overview
        if (this.projectInfo) {
            context.push(`PROJECT: ${this.projectInfo.type} project`);
            if (this.projectInfo.framework) {
                context.push(`FRAMEWORK: ${this.projectInfo.framework}`);
            }
            context.push(`LANGUAGES: ${this.projectInfo.languages.join(', ')}`);
            context.push('');
        }
        // Find relevant files
        const relevantFiles = await this.searchFiles(query, 10);
        // Add working files context
        if (workingFiles.length > 0) {
            context.push('WORKING FILES:');
            for (const filePath of workingFiles) {
                const file = this.fileCache.get(filePath);
                if (file) {
                    context.push(`- ${relative(this.workspacePath, filePath)} (${file.language})`);
                }
            }
            context.push('');
        }
        // Add relevant files
        if (relevantFiles.length > 0) {
            context.push('RELEVANT FILES:');
            for (const file of relevantFiles.slice(0, 5)) {
                const relativePath = relative(this.workspacePath, file.path);
                context.push(`- ${relativePath} (${file.language}) - Score: ${file.relevanceScore}`);
            }
            context.push('');
        }
        // Add file tree for small projects
        if (this.projectInfo && this.projectInfo.totalFiles < 50) {
            const tree = await this.buildFileTree();
            context.push('FILE TREE:');
            context.push(tree);
        }
        const contextString = context.join('\n');
        // Save to history for future reference
        if (this.workspacePath && query) {
            await workspacePersistence.addContextHistory(this.workspacePath, query, contextString);
        }
        return contextString;
    }
    async buildFileTree() {
        const tree = [];
        const files = Array.from(this.fileCache.values())
            .sort((a, b) => a.path.localeCompare(b.path));
        for (const file of files) {
            const relativePath = relative(this.workspacePath, file.path);
            const depth = relativePath.split('/').length - 1;
            const indent = '  '.repeat(depth);
            tree.push(`${indent}${file.name} (${file.language})`);
        }
        return tree.join('\n');
    }
    // Get file content for Claude
    async getFileContent(filePath) {
        try {
            const content = await readFile(filePath, 'utf8');
            return content;
        }
        catch (error) {
            console.warn(`Error reading file ${filePath}:`, error);
            return null;
        }
    }
    // Get project statistics
    getStatistics() {
        return this.projectInfo;
    }
    // Get files by language
    getFilesByLanguage(language) {
        if (this.isDestroyed)
            return [];
        return Array.from(this.fileCache.values())
            .filter(file => file.language === language);
    }
    // Get recently modified files
    getRecentFiles(hours = 24) {
        if (this.isDestroyed)
            return [];
        const cutoff = Date.now() - (hours * 60 * 60 * 1000);
        return Array.from(this.fileCache.values())
            .filter(file => file.lastModified.getTime() > cutoff)
            .sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());
    }
    // File watching methods - now uses centralized FileWatcherService
    async startWatching() {
        if (!this.workspacePath || this.isDestroyed)
            return;
        try {
            // Set up file watching with VERY conservative settings to prevent EMFILE
            console.log(`[LightweightContext] Starting conservative file watching for ${this.workspacePath}`);
            await fileWatcherService.watchDirectory(this.workspacePath, {
                ignored: this.ignorePatterns.map(pattern => `**/${pattern}/**`),
                depth: 0, // EMERGENCY: Only watch workspace root to prevent EMFILE and memory leaks
                usePolling: true, // Force polling to avoid native file descriptor limits
                interval: 5000 // Poll every 5 seconds (much slower but safer)
            });
            // Register for file change events
            const handleFileChange = (data) => {
                if (data.directory === this.workspacePath) {
                    this.handleFileSystemEvent(data.event.type, data.event.path);
                }
            };
            // Remove any existing listeners first to prevent accumulation
            if (this.fileWatcherCleanup) {
                this.fileWatcherCleanup();
                this.fileWatcherCleanup = null;
            }
            fileWatcherService.on('file:change', handleFileChange);
            // Store cleanup function with enhanced cleanup
            this.fileWatcherCleanup = () => {
                fileWatcherService.off('file:change', handleFileChange);
                console.log(`[LightweightContext] Cleaned up file watcher for ${this.workspacePath}`);
            };
            console.log(`[LightweightContext] Emergency file watching enabled (polling mode, depth=0, root only)`);
        }
        catch (error) {
            console.warn('Failed to start file watching:', error);
            console.warn('File watching disabled, IDE will work but won\'t auto-detect file changes');
        }
    }
    stopWatching() {
        // Clean up file watcher event listener
        if (this.fileWatcherCleanup) {
            this.fileWatcherCleanup();
            this.fileWatcherCleanup = null;
        }
        // Stop watching this workspace directory
        if (this.workspacePath) {
            fileWatcherService.unwatchDirectory(this.workspacePath);
        }
        // Clear debounce timer
        if (this.scanDebounceTimer) {
            clearTimeout(this.scanDebounceTimer);
            this.scanDebounceTimer = null;
        }
    }
    handleFileSystemEvent(eventType, filePath) {
        // Debounce rapid file system events
        if (this.scanDebounceTimer) {
            clearTimeout(this.scanDebounceTimer);
        }
        this.scanDebounceTimer = setTimeout(async () => {
            try {
                const relativePath = relative(this.workspacePath, filePath);
                if (eventType === 'add') {
                    // File added
                    await this.addFileToCache(filePath);
                    this.notifyWatchers('add', filePath);
                }
                else if (eventType === 'unlink') {
                    // File removed
                    this.removeFileFromCache(filePath);
                    this.notifyWatchers('remove', filePath);
                }
                else if (eventType === 'change') {
                    // File modified
                    if (this.fileCache.has(filePath)) {
                        await this.updateFileInCache(filePath);
                        this.notifyWatchers('change', filePath);
                    }
                }
                // Update project info if needed
                await this.updateProjectInfo();
            }
            catch (error) {
                console.warn('Error handling file system event:', error);
            }
        }, 300); // 300ms debounce
    }
    async addFileToCache(filePath) {
        try {
            const stats = await stat(filePath);
            if (stats.isFile()) {
                const ext = extname(filePath).toLowerCase();
                const language = this.languageMap[ext] || 'unknown';
                // Skip binary files and very large files
                if (stats.size <= 1024 * 1024 && !this.isBinaryFile(filePath)) {
                    const fileInfo = {
                        path: filePath,
                        name: basename(filePath),
                        size: stats.size,
                        language,
                        lastModified: stats.mtime,
                        isDirectory: false
                    };
                    this.fileCache.set(filePath, fileInfo);
                }
            }
        }
        catch (error) {
            console.warn(`Failed to add file to cache: ${filePath}`, error);
        }
    }
    async updateFileInCache(filePath) {
        const existingFile = this.fileCache.get(filePath);
        if (existingFile) {
            try {
                const stats = await stat(filePath);
                existingFile.lastModified = stats.mtime;
                existingFile.size = stats.size;
            }
            catch (error) {
                console.warn(`Failed to update file in cache: ${filePath}`, error);
            }
        }
    }
    removeFileFromCache(filePath) {
        this.fileCache.delete(filePath);
    }
    async updateProjectInfo() {
        const files = Array.from(this.fileCache.values());
        this.projectInfo = this.analyzeProject(files);
    }
    // Callback management for UI notifications with unique IDs
    onFileChange(callback) {
        const callbackId = `callback_${++this.callbackIdCounter}_${Date.now()}`;
        this.watcherCallbacks.set(callbackId, callback);
        // Return cleanup function
        return () => {
            this.watcherCallbacks.delete(callbackId);
        };
    }
    notifyWatchers(event, filePath) {
        if (this.isDestroyed)
            return;
        // Clean up any callbacks that might have been orphaned
        const deadCallbacks = [];
        for (const [callbackId, callback] of this.watcherCallbacks) {
            try {
                // Check if callback is still valid (not a stale reference)
                if (typeof callback === 'function') {
                    callback(event, filePath);
                }
                else {
                    deadCallbacks.push(callbackId);
                }
            }
            catch (error) {
                console.warn(`Error in file watcher callback ${callbackId}:`, error);
                deadCallbacks.push(callbackId);
            }
        }
        // Remove dead callbacks
        for (const callbackId of deadCallbacks) {
            this.watcherCallbacks.delete(callbackId);
        }
    }
    async loadGitignorePatterns() {
        try {
            const gitignorePath = join(this.workspacePath, '.gitignore');
            if (existsSync(gitignorePath)) {
                const gitignoreContent = await readFile(gitignorePath, 'utf-8');
                const lines = gitignoreContent.split('\n');
                for (const line of lines) {
                    const trimmedLine = line.trim();
                    // Skip empty lines and comments
                    if (!trimmedLine || trimmedLine.startsWith('#'))
                        continue;
                    // Add pattern if not already in default patterns
                    if (!this.ignorePatterns.includes(trimmedLine)) {
                        this.ignorePatterns.push(trimmedLine);
                    }
                }
            }
        }
        catch (error) {
            console.warn('Failed to load .gitignore patterns:', error);
        }
    }
    // Memory monitoring - now much more frequent and aggressive
    startMemoryMonitor() {
        if (this.isDestroyed)
            return;
        // Clear any existing monitor to prevent multiple intervals
        this.stopMemoryMonitor();
        this.memoryMonitorInterval = setInterval(() => {
            if (this.isDestroyed) {
                this.stopMemoryMonitor();
                return;
            }
            const usage = process.memoryUsage();
            const heapUsedMB = usage.heapUsed / 1024 / 1024;
            const heapTotalMB = usage.heapTotal / 1024 / 1024;
            const cacheSize = this.fileCache.size();
            const cacheStats = this.fileCache.getStats();
            // Log memory usage every 30 seconds (but check every 5)
            if (Date.now() % 30000 < this.MEMORY_CHECK_INTERVAL) {
                console.log(`Memory Usage - Heap Used: ${heapUsedMB.toFixed(2)}MB, Heap Total: ${heapTotalMB.toFixed(2)}MB, Files Cached: ${cacheSize}, Hit Rate: ${(cacheStats.hitRate * 100).toFixed(1)}%`);
            }
            // Emergency cleanup if memory usage is too high
            if (usage.heapUsed > this.MEMORY_THRESHOLD) {
                console.warn(`High memory usage detected (${heapUsedMB.toFixed(2)}MB), performing emergency cleanup...`);
                this.emergencyCleanup();
                // Force garbage collection if available
                if (global.gc) {
                    global.gc();
                    console.log('Forced garbage collection');
                }
            }
        }, this.MEMORY_CHECK_INTERVAL); // Check every 5 seconds
    }
    stopMemoryMonitor() {
        if (this.memoryMonitorInterval) {
            clearInterval(this.memoryMonitorInterval);
            this.memoryMonitorInterval = null;
        }
    }
    emergencyCleanup() {
        if (this.isDestroyed)
            return;
        console.log('Performing emergency memory cleanup...');
        const sizeBefore = this.fileCache.size();
        // Force LRU cache cleanup first
        const expiredRemoved = this.fileCache.forceCleanup();
        // If still too many files, clear most of the cache
        if (this.fileCache.size() > 50) {
            // Keep only the most recently accessed files
            const entries = this.fileCache.entries();
            this.fileCache.clear();
            // Re-add only the first 50 entries (most recently used due to LRU)
            let kept = 0;
            for (const [path, file] of entries) {
                if (kept < 50) {
                    const isConfig = this.isConfigFile(file.name) || this.isEntryPoint(file.name);
                    if (isConfig || kept < 30) {
                        this.fileCache.set(path, file);
                        kept++;
                    }
                }
                else {
                    break;
                }
            }
        }
        // Clear any pending timers
        if (this.scanDebounceTimer) {
            clearTimeout(this.scanDebounceTimer);
            this.scanDebounceTimer = null;
        }
        const sizeAfter = this.fileCache.size();
        console.log(`Emergency cleanup completed: ${sizeBefore} -> ${sizeAfter} files (removed ${sizeBefore - sizeAfter}, expired ${expiredRemoved})`);
    }
    // Enhanced cleanup - now properly destroys the instance
    cleanup() {
        if (this.isDestroyed)
            return;
        console.log(`Cleaning up LightweightContext for workspace: ${this.workspacePath}`);
        this.isDestroyed = true;
        this.stopWatching();
        this.stopMemoryMonitor();
        this.fileCache.clear();
        this.projectInfo = null;
        this.watcherCallbacks.clear();
        // Clear any pending timers
        if (this.scanDebounceTimer) {
            clearTimeout(this.scanDebounceTimer);
            this.scanDebounceTimer = null;
        }
    }
    // Get cache size for monitoring
    getCacheSize() {
        return this.fileCache.size();
    }
    // Get cache statistics
    getCacheStats() {
        return this.fileCache.getStats();
    }
    // Force cache cleanup
    forceCleanup() {
        if (this.isDestroyed)
            return 0;
        return this.fileCache.forceCleanup();
    }
    // Check if instance is destroyed
    isInstanceDestroyed() {
        return this.isDestroyed;
    }
    // Memory leak detection
    detectMemoryLeaks() {
        const issues = [];
        const recommendations = [];
        // Check callback count
        const callbackCount = this.watcherCallbacks.size;
        if (callbackCount > 10) {
            issues.push(`Too many file watcher callbacks: ${callbackCount} (expected < 10)`);
            recommendations.push('Review file watcher callback management');
        }
        // Check cache size vs limits
        const cacheSize = this.fileCache.size();
        const cacheUtilization = (cacheSize / this.MAX_FILES) * 100;
        if (cacheUtilization > 90) {
            issues.push(`Cache nearly full: ${cacheSize}/${this.MAX_FILES} files (${cacheUtilization.toFixed(1)}%)`);
            recommendations.push('Consider increasing cache limits or reducing workspace scope');
        }
        // Check for stale timers
        if (this.scanDebounceTimer !== null) {
            issues.push('Scan debounce timer still active');
            recommendations.push('Ensure proper timer cleanup in all code paths');
        }
        // Check memory monitor status
        if (this.memoryMonitorInterval !== null && this.isDestroyed) {
            issues.push('Memory monitor still running on destroyed instance');
            recommendations.push('Fix cleanup sequence to stop monitoring before destruction');
        }
        // Check file watcher cleanup
        if (this.fileWatcherCleanup !== null && this.isDestroyed) {
            issues.push('File watcher cleanup function not called');
            recommendations.push('Ensure file watcher cleanup is called in destruction sequence');
        }
        // Determine severity
        let severity = 'low';
        if (issues.length > 5) {
            severity = 'high';
        }
        else if (issues.length > 2) {
            severity = 'medium';
        }
        return {
            potentialLeaks: issues,
            recommendations,
            severity
        };
    }
    // Get detailed memory statistics
    getMemoryStats() {
        const usage = process.memoryUsage();
        return {
            heapUsed: usage.heapUsed,
            heapTotal: usage.heapTotal,
            cacheSize: this.fileCache.size(),
            callbackCount: this.watcherCallbacks.size,
            timersActive: (this.scanDebounceTimer ? 1 : 0) + (this.memoryMonitorInterval ? 1 : 0),
            isDestroyed: this.isDestroyed
        };
    }
}
// Factory function for creating new instances
export function createLightweightContext() {
    return new LightweightContext();
}
// For backward compatibility during transition, export a function that gets the current workspace context
// This will be removed once all callers are updated to use the WorkspaceContextManager
export function getLightweightContext() {
    console.warn('DEPRECATED: getLightweightContext() is deprecated. Use workspaceContextManager.getCurrentContext() instead.');
    const { workspaceContextManager } = require('./workspace-context-manager.js');
    return workspaceContextManager.getCurrentContext();
}
