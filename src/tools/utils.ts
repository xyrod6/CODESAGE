import { storage } from '../storage/index.js';

// Cache the current project root to avoid unnecessary context switches
let currentProjectRoot: string | null = null;

/**
 * Updates the cached project root. This should be called after setProjectContext
 * to keep the cache in sync.
 */
export function updateProjectRootCache(projectPath: string): void {
  currentProjectRoot = projectPath;
}

/**
 * Ensures the storage is configured for the correct project context.
 * This should be called at the start of every tool handler to ensure
 * Redis keys are properly namespaced for the project being queried.
 *
 * @param projectPath Optional specific project path. If not provided, uses the last indexed project.
 */
export async function ensureProjectContext(projectPath?: string): Promise<void> {
  let targetProject: string;

  if (projectPath) {
    targetProject = projectPath;
  } else {
    // Get the project metadata to determine which project we're working with
    const metadata = await storage.getProjectMetadata();

    if (metadata && metadata.root) {
      targetProject = metadata.root;
    } else {
      throw new Error('No project has been indexed yet. Please run index_project first.');
    }
  }

  // Only switch context if it's different from the current one
  if (currentProjectRoot !== targetProject) {
    await storage.setProjectContext(targetProject);
    currentProjectRoot = targetProject;
  }
}
