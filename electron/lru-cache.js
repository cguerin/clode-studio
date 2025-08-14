export class LRUCache {
    cache = new Map();
    accessOrder = [];
    maxSize;
    maxAge; // in milliseconds
    constructor(maxSize = 1000, maxAge = 30 * 60 * 1000) {
        this.maxSize = maxSize;
        this.maxAge = maxAge;
    }
    get(key) {
        const entry = this.cache.get(key);
        if (!entry) {
            return undefined;
        }
        // Check if entry is expired
        if (Date.now() - entry.timestamp > this.maxAge) {
            this.delete(key);
            return undefined;
        }
        // Update access info
        entry.accessCount++;
        entry.timestamp = Date.now();
        // Move to end of access order (most recently used)
        const index = this.accessOrder.indexOf(key);
        if (index > -1) {
            this.accessOrder.splice(index, 1);
        }
        this.accessOrder.push(key);
        return entry.value;
    }
    set(key, value) {
        const now = Date.now();
        // If key already exists, update it
        if (this.cache.has(key)) {
            const entry = this.cache.get(key);
            entry.value = value;
            entry.timestamp = now;
            entry.accessCount++;
            // Move to end of access order
            const index = this.accessOrder.indexOf(key);
            if (index > -1) {
                this.accessOrder.splice(index, 1);
            }
            this.accessOrder.push(key);
            return;
        }
        // Check if we need to evict entries
        if (this.cache.size >= this.maxSize) {
            this.evictLeastRecentlyUsed();
        }
        // Add new entry
        this.cache.set(key, {
            value,
            timestamp: now,
            accessCount: 1
        });
        this.accessOrder.push(key);
    }
    delete(key) {
        const deleted = this.cache.delete(key);
        if (deleted) {
            const index = this.accessOrder.indexOf(key);
            if (index > -1) {
                this.accessOrder.splice(index, 1);
            }
        }
        return deleted;
    }
    has(key) {
        const entry = this.cache.get(key);
        if (!entry) {
            return false;
        }
        // Check if expired
        if (Date.now() - entry.timestamp > this.maxAge) {
            this.delete(key);
            return false;
        }
        return true;
    }
    clear() {
        this.cache.clear();
        this.accessOrder.length = 0;
    }
    size() {
        return this.cache.size;
    }
    keys() {
        return Array.from(this.cache.keys());
    }
    values() {
        return Array.from(this.cache.values()).map(entry => entry.value);
    }
    entries() {
        return Array.from(this.cache.entries()).map(([key, entry]) => [key, entry.value]);
    }
    evictLeastRecentlyUsed() {
        // Clean up expired entries first
        this.cleanupExpired();
        // If still over limit, remove least recently used
        while (this.cache.size >= this.maxSize && this.accessOrder.length > 0) {
            const lruKey = this.accessOrder.shift();
            if (lruKey !== undefined) {
                this.cache.delete(lruKey);
            }
        }
    }
    cleanupExpired() {
        const now = Date.now();
        const expiredKeys = [];
        for (const [key, entry] of this.cache.entries()) {
            if (now - entry.timestamp > this.maxAge) {
                expiredKeys.push(key);
            }
        }
        for (const key of expiredKeys) {
            this.delete(key);
        }
    }
    // Get cache statistics
    getStats() {
        let totalAccess = 0;
        let expiredEntries = 0;
        const now = Date.now();
        for (const entry of this.cache.values()) {
            totalAccess += entry.accessCount;
            if (now - entry.timestamp > this.maxAge) {
                expiredEntries++;
            }
        }
        return {
            size: this.cache.size,
            maxSize: this.maxSize,
            hitRate: totalAccess > 0 ? this.cache.size / totalAccess : 0,
            expiredEntries
        };
    }
    // Force cleanup of expired entries
    forceCleanup() {
        const sizeBefore = this.cache.size;
        this.cleanupExpired();
        return sizeBefore - this.cache.size;
    }
}
