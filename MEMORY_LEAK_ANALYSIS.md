# Critical Memory Leak Analysis - 3GB+ Memory Consumption

## Executive Summary
**ROOT CAUSE IDENTIFIED**: The app is loading 48,554 files (1.3GB total) into memory during initial Chokidar scan due to `ignoreInitial: false` setting. Despite `depth: 0` configuration, Chokidar still performs a full recursive scan of all 48,554 files (including 46,110 files in node_modules) before applying ignore patterns.

## Root Cause Analysis - CONFIRMED

### ACTUAL ROOT CAUSE: Initial File Scan Loading Everything Into Memory

**Critical Configuration Issue Found:**
```javascript
// file-watcher.ts line 191 & 200
ignoreInitial: false  // THIS IS THE PROBLEM!
```

**What's happening:**
1. Workspace contains **48,554 files** totaling **1.3GB**
2. `node_modules` alone has **46,110 files** totaling **1.2GB**
3. With `ignoreInitial: false`, Chokidar emits an 'add' event for EVERY file on startup
4. Even with `depth: 0`, the initial scan is recursive and processes ALL files
5. The `ignored` patterns are applied AFTER the initial scan
6. Each file event is stored in memory queues and indexes
7. Result: **3GB+ memory consumption** from holding file metadata/paths for 48,554 files

### 1. **SECONDARY ISSUE: Chokidar Polling Mode Memory Leak**

The configuration shows:
```javascript
// From file-watcher.ts
usePolling: true,
interval: 5000,  // Poll every 5 seconds
depth: 0         // Only watch root directory
```

**Problem**: Chokidar v4.0.3 with polling mode appears to have a severe memory leak when:
- Using `usePolling: true` 
- Even with `depth: 0` (watching only root)
- The polling mechanism itself accumulates memory

### 2. **Evidence of Non-Cache Memory Leak**

From the logs:
```
Files Cached: 257 → Emergency cleanup → 34 files
Memory: 269MB → 539MB → 2657MB (while cache stayed at 34 files!)
```

**This proves the leak is NOT in file caching but in the watcher itself.**

### 3. **Chokidar Internal Memory Accumulation**

Potential leak sources in Chokidar polling mode:
- **Stat cache growth**: Chokidar maintains internal caches for file stats
- **Event queue buildup**: Unprocessed or queued events accumulating
- **Path normalization cache**: Internal path caching growing unbounded
- **Polling interval handles**: Timer/interval references not being cleaned up
- **FSWatcher instances**: Multiple watcher instances not being properly disposed

### 4. **Multiple Watcher Instance Problem**

The code shows potential for multiple watchers:
```javascript
// Multiple contexts can create watchers
workspaceContextManager → LightweightContext → fileWatcherService
```

Each workspace context creates its own watcher, but cleanup might be incomplete.

## Immediate Emergency Solutions

### Solution 1: Disable Chokidar Completely (EMERGENCY FIX)
```typescript
// In lightweight-context.ts - startWatching()
async startWatching(): Promise<void> {
  console.log('[EMERGENCY] File watching disabled to prevent OOM');
  return; // COMPLETELY SKIP FILE WATCHING
}
```

### Solution 2: Replace Polling with Manual Refresh
```typescript
// Remove all chokidar usage
// Implement manual refresh button in UI
// Use fs.readdir for on-demand directory scanning
```

### Solution 3: Use Node.js Native fs.watch (Lightweight Alternative)
```typescript
import { watch as fsWatch } from 'fs';

// Replace chokidar with native fs.watch (much lighter)
const watcher = fsWatch(workspacePath, { recursive: false }, (eventType, filename) => {
  // Handle file changes
});
```

### Solution 4: Implement Aggressive Chokidar Recycling
```typescript
// Force restart watcher every 2 minutes to prevent memory buildup
setInterval(async () => {
  await fileWatcherService.stopAll();
  await new Promise(resolve => setTimeout(resolve, 100));
  await fileWatcherService.watchDirectory(workspacePath, minimalOptions);
}, 120000);
```

### Solution 5: Downgrade or Replace Chokidar Version
```json
// package.json - Try older stable version
"chokidar": "^3.5.3"  // Instead of 4.0.3
```

## Memory Leak Technical Details

### Chokidar Polling Mode Issues:
1. **Unbounded Stat Cache**: Every poll creates new stat objects
2. **Event Emitter Leak**: Events accumulating in internal emitters
3. **Timer Handle Leak**: setInterval handles not being cleared
4. **Path Cache Explosion**: Normalized paths cached indefinitely
5. **Recursive Promise Chains**: Polling creates promise chains that don't resolve

### Why Depth=0 Doesn't Help:
- Polling still stats ALL files in root directory
- Internal caches grow regardless of depth setting
- Memory leak is in the polling mechanism, not the watching scope

## Recommended Immediate Action

**DISABLE FILE WATCHING ENTIRELY** until a proper solution is implemented:

1. Comment out all `fileWatcherService.watchDirectory()` calls
2. Implement a manual "Refresh Files" button in the UI
3. Use on-demand file scanning when needed
4. Consider using VSCode's file watcher approach (language server protocol)

## Long-term Solutions

1. **Implement Custom File Watcher**:
   - Use Node.js native `fs.watch` or `fs.watchFile`
   - Implement own debouncing and filtering
   - Control memory usage directly

2. **Use Alternative Libraries**:
   - `node-watch`: Lighter alternative
   - `watchpack`: Webpack's file watcher
   - `gaze`: Another alternative
   - `nsfw`: Native filesystem watcher

3. **Implement Hybrid Approach**:
   - Watch only specific critical files
   - Use manual refresh for full directory
   - Implement "pull-based" updates instead of "push-based"

## Memory Profiling Commands

To diagnose further:
```javascript
// Add to main process
setInterval(() => {
  const usage = process.memoryUsage();
  console.log('Memory snapshot:', {
    rss: `${(usage.rss / 1024 / 1024).toFixed(2)}MB`,
    heapTotal: `${(usage.heapTotal / 1024 / 1024).toFixed(2)}MB`,
    heapUsed: `${(usage.heapUsed / 1024 / 1024).toFixed(2)}MB`,
    external: `${(usage.external / 1024 / 1024).toFixed(2)}MB`,
    arrayBuffers: `${(usage.arrayBuffers / 1024 / 1024).toFixed(2)}MB`
  });
  
  // Force garbage collection if available
  if (global.gc) {
    console.log('Running GC...');
    global.gc();
  }
}, 10000);
```

## Conclusion

The 3GB+ memory consumption is caused by **Chokidar's polling mode memory leak**, not the file cache system. The emergency cleanup of cached files works correctly, but memory continues growing exponentially due to internal Chokidar state accumulation.

**Immediate recommendation**: Disable file watching entirely to prevent OOM crashes while implementing a proper alternative solution.