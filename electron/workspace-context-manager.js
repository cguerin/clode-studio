import { LightweightContext } from './lightweight-context.js';
export class WorkspaceContextManager {
    instances = new Map();
    currentWorkspacePath = null;
    cleanupInterval = null;
    MAX_INSTANCES = 5; // Keep max 5 workspaces in memory
    CLEANUP_INTERVAL = 60000; // Clean up every minute
    INSTANCE_TTL = 30 * 60 * 1000; // 30 minutes TTL
    constructor() {
        this.startCleanupTimer();
    }
    /**
     * Get or create a LightweightContext instance for a workspace
     */
    async getOrCreateContext(workspacePath) {
        // Normalize path
        const normalizedPath = this.normalizePath(workspacePath);
        // Check if we already have an instance
        let instance = this.instances.get(normalizedPath);
        if (instance) {
            // Update access time
            instance.lastAccessed = Date.now();
            instance.isActive = true;
            // Deactivate previous workspace
            if (this.currentWorkspacePath && this.currentWorkspacePath !== normalizedPath) {
                const prevInstance = this.instances.get(this.currentWorkspacePath);
                if (prevInstance) {
                    prevInstance.isActive = false;
                }
            }
            this.currentWorkspacePath = normalizedPath;
            return instance.context;
        }
        // Create new instance
        const context = new LightweightContext();
        instance = {
            context,
            workspacePath: normalizedPath,
            createdAt: Date.now(),
            lastAccessed: Date.now(),
            isActive: true
        };
        // Clean up old instances if we're at the limit
        if (this.instances.size >= this.MAX_INSTANCES) {
            await this.evictOldestInactiveInstance();
        }
        // Deactivate previous workspace
        if (this.currentWorkspacePath) {
            const prevInstance = this.instances.get(this.currentWorkspacePath);
            if (prevInstance) {
                prevInstance.isActive = false;
            }
        }
        // Store new instance
        this.instances.set(normalizedPath, instance);
        this.currentWorkspacePath = normalizedPath;
        // Initialize the context
        try {
            await context.initialize(normalizedPath);
        }
        catch (error) {
            // If initialization fails, remove the instance
            this.instances.delete(normalizedPath);
            if (this.currentWorkspacePath === normalizedPath) {
                this.currentWorkspacePath = null;
            }
            throw error;
        }
        return context;
    }
    /**
     * Get the current active workspace context
     */
    getCurrentContext() {
        if (!this.currentWorkspacePath) {
            return null;
        }
        const instance = this.instances.get(this.currentWorkspacePath);
        return instance ? instance.context : null;
    }
    /**
     * Get the current workspace path
     */
    getCurrentWorkspacePath() {
        return this.currentWorkspacePath;
    }
    /**
     * Switch to a different workspace
     */
    async switchWorkspace(workspacePath) {
        return this.getOrCreateContext(workspacePath);
    }
    /**
     * Close a specific workspace
     */
    async closeWorkspace(workspacePath) {
        const normalizedPath = this.normalizePath(workspacePath);
        const instance = this.instances.get(normalizedPath);
        if (instance) {
            // Clean up the context
            instance.context.cleanup();
            // Remove from instances
            this.instances.delete(normalizedPath);
            // Clear current workspace if it was this one
            if (this.currentWorkspacePath === normalizedPath) {
                this.currentWorkspacePath = null;
            }
        }
    }
    /**
     * Close all workspaces
     */
    async closeAllWorkspaces() {
        for (const [path, instance] of this.instances) {
            instance.context.cleanup();
        }
        this.instances.clear();
        this.currentWorkspacePath = null;
    }
    /**
     * Get statistics about managed instances
     */
    getStats() {
        const stats = {
            totalInstances: this.instances.size,
            activeInstances: 0,
            currentWorkspace: this.currentWorkspacePath,
            memoryUsage: []
        };
        const now = Date.now();
        for (const [path, instance] of this.instances) {
            if (instance.isActive) {
                stats.activeInstances++;
            }
            stats.memoryUsage.push({
                workspacePath: path,
                cacheSize: instance.context.getCacheSize(),
                isActive: instance.isActive,
                ageMinutes: Math.floor((now - instance.createdAt) / 60000)
            });
        }
        return stats;
    }
    /**
     * Force cleanup of old instances
     */
    async forceCleanup() {
        let cleaned = 0;
        const now = Date.now();
        const instancesToRemove = [];
        for (const [path, instance] of this.instances) {
            // Remove instances that are inactive and old
            const age = now - instance.lastAccessed;
            if (!instance.isActive && age > this.INSTANCE_TTL) {
                instancesToRemove.push(path);
            }
        }
        for (const path of instancesToRemove) {
            await this.closeWorkspace(path);
            cleaned++;
        }
        return cleaned;
    }
    /**
     * Shutdown the manager
     */
    async shutdown() {
        // Stop cleanup timer
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
        }
        // Close all workspaces
        await this.closeAllWorkspaces();
    }
    normalizePath(path) {
        // Normalize path separators and remove trailing slashes
        return path.replace(/\\/g, '/').replace(/\/+$/, '');
    }
    async evictOldestInactiveInstance() {
        let oldestPath = null;
        let oldestTime = Date.now();
        // Find the oldest inactive instance
        for (const [path, instance] of this.instances) {
            if (!instance.isActive && instance.lastAccessed < oldestTime) {
                oldestTime = instance.lastAccessed;
                oldestPath = path;
            }
        }
        // If no inactive instances, find the oldest active one (excluding current)
        if (!oldestPath) {
            for (const [path, instance] of this.instances) {
                if (path !== this.currentWorkspacePath && instance.lastAccessed < oldestTime) {
                    oldestTime = instance.lastAccessed;
                    oldestPath = path;
                }
            }
        }
        if (oldestPath) {
            await this.closeWorkspace(oldestPath);
        }
    }
    startCleanupTimer() {
        this.cleanupInterval = setInterval(async () => {
            try {
                await this.forceCleanup();
                // Also trigger cache cleanup on all active instances
                for (const instance of this.instances.values()) {
                    if (instance.context.forceCleanup) {
                        instance.context.forceCleanup();
                    }
                }
            }
            catch (error) {
                console.warn('Error during workspace context cleanup:', error);
            }
        }, this.CLEANUP_INTERVAL);
    }
}
// Global instance
export const workspaceContextManager = new WorkspaceContextManager();
