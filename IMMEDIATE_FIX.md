# IMMEDIATE FIX FOR 3GB MEMORY LEAK

## Root Cause
The app is scanning and loading metadata for **48,554 files** (including 46,110 files in node_modules) into memory due to `ignoreInitial: false` in Chokidar configuration.

## Quick Fix #1: Change ignoreInitial to true

Edit `/electron/file-watcher.ts` lines 191 and 200:

```typescript
// CHANGE FROM:
ignoreInitial: false

// CHANGE TO:
ignoreInitial: true  // Don't scan existing files on startup
```

## Quick Fix #2: Fix the ignore patterns BEFORE watching

The current code has ignore patterns but they're not properly formatted. Update line 144-168:

```typescript
const defaultOptions: WatcherOptions = {
  ignored: [
    '**/node_modules',  // REMOVE the /** suffix - just use the directory name
    '**/.git',
    '**/dist',
    '**/build',
    // ... rest of patterns
  ],
  depth: 0,  // Only watch root
  ignoreInitial: true,  // Don't scan existing files
  usePolling: false,  // Disable polling to save CPU
  followSymlinks: false
};
```

## Quick Fix #3: Add proper depth=0 enforcement

The current depth=0 is being overridden. Ensure it's actually applied:

```typescript
// Line 189-193
watcher = watch(dirPath, {
  persistent: true,
  ignoreInitial: true,  // CRITICAL: Skip initial scan
  depth: 0,  // CRITICAL: Only watch root directory
  ignored: ['**/node_modules', '**/.git', '**/dist', '**/build'],
  ...mergedOptions
});
```

## Quick Fix #4: Emergency Disable (if above doesn't work)

In `/electron/lightweight-context.ts` line 632, completely disable watching:

```typescript
async startWatching(): Promise<void> {
  console.log('[EMERGENCY] File watching disabled to prevent OOM');
  return; // Skip all file watching
}
```

## Testing the Fix

1. Make the changes above
2. Restart the app
3. Monitor memory usage:
   - Should stay under 100MB
   - No 3GB spike
   - No OOM crashes

## Long-term Solution

1. Never scan node_modules
2. Use a whitelist approach (only watch specific file types)
3. Implement lazy loading of file metadata
4. Use native fs.watch for critical files only
5. Consider using .gitignore patterns for ignore list

## Verification Commands

Check if node_modules is being scanned:
```bash
# In the app console, you should NOT see:
# "handleFileEvent: add /path/to/node_modules/..."

# Memory should stay low:
process.memoryUsage().heapUsed / 1024 / 1024  // Should be < 100MB
```