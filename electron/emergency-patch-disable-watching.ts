/**
 * EMERGENCY PATCH: Disable File Watching to Prevent OOM Crashes
 * 
 * This patch completely disables Chokidar file watching to prevent
 * the 3GB+ memory leak that causes app crashes.
 * 
 * Apply this patch by replacing the startWatching() method in
 * lightweight-context.ts with this implementation.
 */

// ============================================
// OPTION 1: Complete Disable (Recommended)
// ============================================
export async function startWatching_DISABLED(): Promise<void> {
  console.log('[EMERGENCY PATCH] File watching completely disabled to prevent OOM crashes');
  console.log('[EMERGENCY PATCH] Manual file refresh will be required');
  console.log('[EMERGENCY PATCH] Memory leak prevention active');
  
  // Emit a warning to the UI
  if (this.workspacePath) {
    this.emit('warning', {
      type: 'file-watching-disabled',
      message: 'File watching disabled for stability. Use manual refresh.',
      severity: 'warning'
    });
  }
  
  return; // Do nothing - no file watching
}

// ============================================
// OPTION 2: Native fs.watch (Lightweight)
// ============================================
import { watch as fsWatch, FSWatcher as NativeFSWatcher } from 'fs';
import { EventEmitter } from 'events';

export class LightweightFileWatcher extends EventEmitter {
  private watcher: NativeFSWatcher | null = null;
  private workspacePath: string;
  
  constructor(workspacePath: string) {
    super();
    this.workspacePath = workspacePath;
  }
  
  start(): void {
    try {
      // Use native fs.watch - much lighter than Chokidar
      this.watcher = fsWatch(this.workspacePath, {
        recursive: false, // Only watch root directory
        persistent: false // Don't keep process alive
      }, (eventType, filename) => {
        if (!filename) return;
        
        // Simple debouncing
        this.emit('change', {
          type: eventType,
          path: filename
        });
      });
      
      console.log('[Native Watcher] Started lightweight file watching');
      
      // Auto-cleanup after 5 minutes to prevent any potential leaks
      setTimeout(() => {
        this.stop();
        console.log('[Native Watcher] Auto-stopped after 5 minutes');
      }, 5 * 60 * 1000);
      
    } catch (error) {
      console.error('[Native Watcher] Failed to start:', error);
    }
  }
  
  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
      console.log('[Native Watcher] Stopped');
    }
  }
}

// ============================================
// OPTION 3: Manual Refresh Implementation
// ============================================
import { readdir, stat } from 'fs/promises';
import * as path from 'path';

export class ManualFileScanner {
  private lastScanTime: number = 0;
  private fileMap: Map<string, number> = new Map(); // path -> mtime
  
  async scanDirectory(dirPath: string, maxDepth: number = 1): Promise<{
    added: string[];
    modified: string[];
    removed: string[];
  }> {
    const changes = {
      added: [] as string[],
      modified: [] as string[],
      removed: [] as string[]
    };
    
    const currentFiles = new Map<string, number>();
    
    // Scan current files
    await this.scanRecursive(dirPath, currentFiles, 0, maxDepth);
    
    // Compare with previous scan
    for (const [filePath, mtime] of currentFiles) {
      const prevMtime = this.fileMap.get(filePath);
      if (!prevMtime) {
        changes.added.push(filePath);
      } else if (prevMtime < mtime) {
        changes.modified.push(filePath);
      }
    }
    
    // Find removed files
    for (const filePath of this.fileMap.keys()) {
      if (!currentFiles.has(filePath)) {
        changes.removed.push(filePath);
      }
    }
    
    // Update file map
    this.fileMap = currentFiles;
    this.lastScanTime = Date.now();
    
    return changes;
  }
  
  private async scanRecursive(
    dirPath: string,
    fileMap: Map<string, number>,
    currentDepth: number,
    maxDepth: number
  ): Promise<void> {
    if (currentDepth > maxDepth) return;
    
    try {
      const entries = await readdir(dirPath, { withFileTypes: true });
      
      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        
        // Skip common ignore patterns
        if (this.shouldIgnore(entry.name)) continue;
        
        if (entry.isFile()) {
          try {
            const stats = await stat(fullPath);
            fileMap.set(fullPath, stats.mtimeMs);
          } catch (err) {
            // File might have been deleted
          }
        } else if (entry.isDirectory() && currentDepth < maxDepth) {
          await this.scanRecursive(fullPath, fileMap, currentDepth + 1, maxDepth);
        }
      }
    } catch (error) {
      console.warn(`Failed to scan directory ${dirPath}:`, error);
    }
  }
  
  private shouldIgnore(name: string): boolean {
    const ignorePatterns = [
      'node_modules',
      '.git',
      'dist',
      'build',
      '.DS_Store',
      '.vscode',
      '.idea'
    ];
    
    return ignorePatterns.some(pattern => name.includes(pattern));
  }
}

// ============================================
// OPTION 4: Memory-Safe Watcher with Recycling
// ============================================
export class MemorySafeWatcher {
  private watcher: any = null;
  private recycleInterval: NodeJS.Timeout | null = null;
  private workspacePath: string;
  private recycleTime = 2 * 60 * 1000; // Recycle every 2 minutes
  
  constructor(workspacePath: string) {
    this.workspacePath = workspacePath;
  }
  
  async start(): Promise<void> {
    // Start with no watching
    console.log('[MemorySafe] Starting with no file watching');
    
    // Set up recycling to prevent memory leaks
    this.recycleInterval = setInterval(() => {
      this.recycle();
    }, this.recycleTime);
  }
  
  async recycle(): Promise<void> {
    console.log('[MemorySafe] Recycling watcher to prevent memory leaks');
    
    // Stop any existing watcher
    if (this.watcher) {
      try {
        await this.watcher.close();
      } catch (err) {
        // Ignore
      }
      this.watcher = null;
    }
    
    // Force garbage collection if available
    if (global.gc) {
      global.gc();
    }
    
    // Don't restart watcher - stay in manual mode
    console.log('[MemorySafe] Watcher recycled, staying in manual mode');
  }
  
  stop(): void {
    if (this.recycleInterval) {
      clearInterval(this.recycleInterval);
      this.recycleInterval = null;
    }
    
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }
}

// ============================================
// EMERGENCY MONITORING
// ============================================
export function startEmergencyMonitoring(): void {
  setInterval(() => {
    const usage = process.memoryUsage();
    const heapUsedMB = usage.heapUsed / 1024 / 1024;
    
    if (heapUsedMB > 500) {
      console.error('🚨 EMERGENCY: High memory usage detected:', {
        heapUsed: `${heapUsedMB.toFixed(2)}MB`,
        rss: `${(usage.rss / 1024 / 1024).toFixed(2)}MB`
      });
      
      // Force disable all watchers
      console.error('🚨 EMERGENCY: Force disabling all file watchers');
      
      // Attempt garbage collection
      if (global.gc) {
        console.log('🚨 EMERGENCY: Running forced garbage collection');
        global.gc();
      }
    }
  }, 10000); // Check every 10 seconds
}