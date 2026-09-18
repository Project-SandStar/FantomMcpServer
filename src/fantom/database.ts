/**
 * Prisma-based database manager for Fantom Instance and Pod Management
 */

import * as fs from 'fs';
import * as path from 'path';
import { getCachePath } from '../utils/installRoot.js';
import { getPrismaClient, type Instance, type Pod, type CompileLog as PrismaCompileLog, type FantomProject, type DocIndex, type FantomBuild as PrismaFantomBuild } from '../db/index.js';
import type {
  FantomInstance,
  FantomPod,
  FantomPodWithInstance,
  FantomPodWithCounts,
  CompileLog,
  CreateInstanceInput,
  UpdateInstanceInput,
  CreatePodInput,
  UpdatePodInput,
  CompileStatus,
  FantomInstanceSettings,
  FantomProjectRecord,
  CreateProjectInput,
  UpdateProjectInput,
  FantomBuild,
  CreateFantomBuildInput,
  UpdateFantomBuildInput
} from './types.js';

/**
 * Thrown when createProject is called with a `path` that already belongs to
 * another FantomProject. Callers translate this into HTTP 409 / structured
 * MCP error so the user can decide whether to reuse, rename, or override.
 */
export class ProjectPathConflictError extends Error {
  readonly code = 'PROJECT_PATH_CONFLICT';
  constructor(public readonly existing: FantomProjectRecord) {
    super(
      `Project path already registered as "${existing.name}" (id=${existing.id}). ` +
      `Use the existing project or remove it first.`
    );
    this.name = 'ProjectPathConflictError';
  }
}

/**
 * Database manager for Fantom instances and pods using Prisma
 */
export class FantomDatabase {
  private initialized = false;

  constructor(_dbPath?: string) {
    // dbPath is no longer used with Prisma (configured via DATABASE_URL)
  }

  /**
   * Initialize the database connection
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Prisma client handles connection automatically
    // Just verify we can connect
    const prisma = getPrismaClient();
    await prisma.$queryRaw`SELECT 1`;
    this.initialized = true;
  }

  // ===========================================
  // Instance CRUD Operations
  // ===========================================

  /**
   * Create a new instance
   */
  async createInstance(input: CreateInstanceInput): Promise<FantomInstance> {
    const prisma = getPrismaClient();

    const fanExecutable = input.fanExecutable || this.detectFanExecutable(input.path);
    const isValid = this.validateInstancePath(input.path, fanExecutable);

    // Validate docSourceInstanceId - must reference a SkySpark instance
    if (input.docSourceInstanceId) {
      const docSource = await this.getInstanceById(input.docSourceInstanceId);
      if (!docSource) {
        throw new Error(`docSourceInstanceId ${input.docSourceInstanceId} not found`);
      }
      if (docSource.type !== 'skyspark') {
        throw new Error(`docSourceInstanceId must reference a SkySpark instance, got ${docSource.type}`);
      }
    }

    const instance = await prisma.instance.create({
      data: {
        name: input.name,
        path: input.path,
        type: input.type || 'fantom',
        version: input.version || null,
        fanExecutable: fanExecutable,
        description: input.description || null,
        sourcePath: input.sourcePath || null,
        fantomVersion: input.fantomVersion || null,
        fantomSourcePath: input.fantomSourcePath || null,
        docSourceInstanceId: input.docSourceInstanceId || null,
        isValid: isValid,
      },
    });

    return this.prismaToInstance(instance);
  }

  /**
   * Get all instances
   */
  async getAllInstances(): Promise<FantomInstance[]> {
    const prisma = getPrismaClient();
    const instances = await prisma.instance.findMany({
      orderBy: { name: 'asc' },
    });
    return instances.map(this.prismaToInstance);
  }

  /**
   * Get all SkySpark instances, optionally filtered by version
   * Returns instances with matching version first, then other versions
   */
  async getSkySarkInstances(version?: string): Promise<{
    instances: FantomInstance[];
    matchingVersion: FantomInstance[];
    otherVersions: FantomInstance[];
  }> {
    const prisma = getPrismaClient();
    const instances = await prisma.instance.findMany({
      where: { type: 'skyspark' },
      orderBy: { name: 'asc' },
    });

    const allInstances = instances.map(this.prismaToInstance);

    if (!version) {
      return {
        instances: allInstances,
        matchingVersion: [],
        otherVersions: allInstances,
      };
    }

    const matchingVersion = allInstances.filter(i => i.version === version);
    const otherVersions = allInstances.filter(i => i.version !== version);

    return {
      instances: allInstances,
      matchingVersion,
      otherVersions,
    };
  }

  /**
   * Get the doc source instance for a given instance
   * Returns the linked SkySpark instance if docSourceInstanceId is set
   */
  async getDocSourceInstance(instanceId: number): Promise<FantomInstance | null> {
    const instance = await this.getInstanceById(instanceId);
    if (!instance || !instance.docSourceInstanceId) {
      return null;
    }
    return this.getInstanceById(instance.docSourceInstanceId);
  }

  /**
   * Get instance by ID
   */
  async getInstanceById(id: number): Promise<FantomInstance | null> {
    const prisma = getPrismaClient();
    const instance = await prisma.instance.findUnique({
      where: { id },
    });
    return instance ? this.prismaToInstance(instance) : null;
  }

  /**
   * Get instance by name
   */
  async getInstanceByName(name: string): Promise<FantomInstance | null> {
    const prisma = getPrismaClient();
    const instance = await prisma.instance.findUnique({
      where: { name },
    });
    return instance ? this.prismaToInstance(instance) : null;
  }

  /**
   * Update an instance
   */
  async updateInstance(id: number, input: UpdateInstanceInput): Promise<FantomInstance | null> {
    const prisma = getPrismaClient();

    const existing = await this.getInstanceById(id);
    if (!existing) return null;

    const newPath = input.path ?? existing.path;
    const newFanExecutable = input.fanExecutable ?? existing.fanExecutable;
    const isValid = this.validateInstancePath(newPath, newFanExecutable);

    // Validate docSourceInstanceId - must reference a SkySpark instance
    if (input.docSourceInstanceId !== undefined && input.docSourceInstanceId !== null) {
      const docSource = await this.getInstanceById(input.docSourceInstanceId);
      if (!docSource) {
        throw new Error(`docSourceInstanceId ${input.docSourceInstanceId} not found`);
      }
      if (docSource.type !== 'skyspark') {
        throw new Error(`docSourceInstanceId must reference a SkySpark instance, got ${docSource.type}`);
      }
    }

    const instance = await prisma.instance.update({
      where: { id },
      data: {
        name: input.name ?? undefined,
        path: input.path ?? undefined,
        type: input.type ?? undefined,
        version: input.version ?? undefined,
        fanExecutable: input.fanExecutable ?? undefined,
        description: input.description ?? undefined,
        sourcePath: input.sourcePath !== undefined ? input.sourcePath : undefined,
        fantomVersion: input.fantomVersion !== undefined ? input.fantomVersion : undefined,
        fantomSourcePath: input.fantomSourcePath !== undefined ? input.fantomSourcePath : undefined,
        docSourceInstanceId: input.docSourceInstanceId !== undefined ? input.docSourceInstanceId : undefined,
        isValid: isValid,
      },
    });

    return this.prismaToInstance(instance);
  }

  /**
   * Delete an instance
   */
  async deleteInstance(id: number): Promise<boolean> {
    const prisma = getPrismaClient();

    // Check if this is the active instance
    const activeId = await this.getActiveInstanceId();
    if (activeId === id) {
      await this.setSetting('active_instance_id', '');
    }

    try {
      await prisma.instance.delete({
        where: { id },
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Validate an instance path and fan executable
   */
  async validateInstance(id: number): Promise<{ isValid: boolean; error?: string }> {
    const prisma = getPrismaClient();

    const instance = await this.getInstanceById(id);
    if (!instance) {
      return { isValid: false, error: 'Instance not found' };
    }

    if (!fs.existsSync(instance.path)) {
      await prisma.instance.update({
        where: { id },
        data: { isValid: false },
      });
      return { isValid: false, error: `Path does not exist: ${instance.path}` };
    }

    const fanPath = path.join(instance.path, instance.fanExecutable);
    if (!fs.existsSync(fanPath)) {
      await prisma.instance.update({
        where: { id },
        data: { isValid: false },
      });
      return { isValid: false, error: `Fan executable not found: ${fanPath}` };
    }

    await prisma.instance.update({
      where: { id },
      data: { isValid: true },
    });
    return { isValid: true };
  }

  // ===========================================
  // Pod CRUD Operations
  // ===========================================

  /**
   * Create a new pod
   */
  async createPod(input: CreatePodInput): Promise<FantomPod> {
    const prisma = getPrismaClient();

    const pod = await prisma.pod.create({
      data: {
        name: input.name,
        path: input.path,
        buildFile: input.buildFile || 'build.fan',
        description: input.description || null,
        defaultInstanceId: input.defaultInstanceId || null,
        compatMinVersion: input.compatMinVersion || null,
        compatMaxVersion: input.compatMaxVersion || null,
        compatVersions: input.compatVersions ? JSON.stringify(input.compatVersions) : null,
      },
    });

    return this.prismaToPod(pod);
  }

  /**
   * Get all pods
   */
  async getAllPods(): Promise<FantomPod[]> {
    const prisma = getPrismaClient();
    const pods = await prisma.pod.findMany({
      orderBy: { name: 'asc' },
    });
    return pods.map(this.prismaToPod);
  }

  /**
   * Get all pods with their associated instance info
   */
  async getAllPodsWithInstance(): Promise<FantomPodWithInstance[]> {
    const prisma = getPrismaClient();
    const pods = await prisma.pod.findMany({
      include: {
        defaultInstance: true,
      },
      orderBy: { name: 'asc' },
    });

    return pods.map(pod => {
      const basePod = this.prismaToPod(pod);
      return {
        ...basePod,
        instance: pod.defaultInstance ? {
          id: pod.defaultInstance.id,
          name: pod.defaultInstance.name,
          type: pod.defaultInstance.type as 'fantom' | 'skyspark' | 'haxall',
          version: pod.defaultInstance.version || undefined,
        } : undefined,
      };
    });
  }

  /**
   * Get all pods with instance info AND item counts from DocIndex/FantomProject
   * This is used by listFantomPods to show meaningful counts
   */
  async getAllPodsWithCounts(): Promise<FantomPodWithCounts[]> {
    const prisma = getPrismaClient();

    // Get all pods with their instances
    const pods = await prisma.pod.findMany({
      include: {
        defaultInstance: true,
      },
      orderBy: { name: 'asc' },
    });

    // Get all doc indexes for counting
    const docIndexes = await prisma.docIndex.findMany();
    const docIndexMap = new Map<string, number>(); // "instanceId:podName" -> itemCount
    for (const di of docIndexes) {
      docIndexMap.set(`${di.instanceId}:${di.podName}`, di.itemCount);
    }

    // Get all projects with their instances for function/type counts
    const projects = await prisma.fantomProject.findMany({
      include: {
        instance: true,
      },
    });

    // Build project map by podName for quick lookup
    const projectMap = new Map<string, { functions: number; types: number; instanceId?: number }>();
    for (const p of projects) {
      if (p.podName) {
        const existing = projectMap.get(p.podName);
        // Aggregate counts if same podName appears multiple times
        if (existing) {
          existing.functions += p.functionCount;
          existing.types += p.typeCount;
        } else {
          projectMap.set(p.podName, {
            functions: p.functionCount,
            types: p.typeCount,
            instanceId: p.instanceId || undefined,
          });
        }
      }
    }

    const result: FantomPodWithCounts[] = [];
    const processedPodNames = new Set<string>();

    // First, process pods from the pods table
    for (const pod of pods) {
      const basePod = this.prismaToPod(pod);
      processedPodNames.add(pod.name);

      // Get doc item count from DocIndex (if instance is set)
      let docItems = 0;
      if (pod.defaultInstanceId) {
        docItems = docIndexMap.get(`${pod.defaultInstanceId}:${pod.name}`) || 0;
      }

      // Get function/type counts from FantomProject (if pod is indexed as project)
      const projectCounts = projectMap.get(pod.name) || { functions: 0, types: 0 };

      result.push({
        ...basePod,
        instance: pod.defaultInstance ? {
          id: pod.defaultInstance.id,
          name: pod.defaultInstance.name,
          type: pod.defaultInstance.type as 'fantom' | 'skyspark' | 'haxall',
          version: pod.defaultInstance.version || undefined,
        } : undefined,
        counts: {
          docItems,
          functions: projectCounts.functions,
          types: projectCounts.types,
        },
      });
    }

    // Second, add projects from fantom_projects that aren't in pods table
    for (const project of projects) {
      if (!project.podName || processedPodNames.has(project.podName)) {
        continue;
      }
      processedPodNames.add(project.podName);

      const projectCounts = projectMap.get(project.podName) || { functions: 0, types: 0 };

      result.push({
        id: project.id,
        name: project.podName,
        path: project.path,
        buildFile: 'build.fan',
        description: project.description || undefined,
        defaultInstanceId: project.instanceId || undefined,
        compatMaxVersion: undefined,
        compatMinVersion: undefined,
        compatVersions: [],
        createdAt: project.createdAt.toISOString(),
        updatedAt: project.updatedAt.toISOString(),
        instance: project.instance ? {
          id: project.instance.id,
          name: project.instance.name,
          type: project.instance.type as 'fantom' | 'skyspark' | 'haxall',
          version: project.instance.version || undefined,
        } : undefined,
        counts: {
          docItems: 0,
          functions: projectCounts.functions,
          types: projectCounts.types,
        },
      });
    }

    return result;
  }

  /**
   * Get pods by instance ID
   */
  async getPodsByInstance(instanceId: number): Promise<FantomPodWithInstance[]> {
    const prisma = getPrismaClient();
    const pods = await prisma.pod.findMany({
      where: { defaultInstanceId: instanceId },
      include: {
        defaultInstance: true,
      },
      orderBy: { name: 'asc' },
    });

    return pods.map(pod => {
      const basePod = this.prismaToPod(pod);
      return {
        ...basePod,
        instance: pod.defaultInstance ? {
          id: pod.defaultInstance.id,
          name: pod.defaultInstance.name,
          type: pod.defaultInstance.type as 'fantom' | 'skyspark' | 'haxall',
          version: pod.defaultInstance.version || undefined,
        } : undefined,
      };
    });
  }

  /**
   * Get pods without an assigned instance
   */
  async getUnassignedPods(): Promise<FantomPod[]> {
    const prisma = getPrismaClient();
    const pods = await prisma.pod.findMany({
      where: { defaultInstanceId: null },
      orderBy: { name: 'asc' },
    });
    return pods.map(this.prismaToPod);
  }

  /**
   * Get pod by ID
   */
  async getPodById(id: number): Promise<FantomPod | null> {
    const prisma = getPrismaClient();
    const pod = await prisma.pod.findUnique({
      where: { id },
    });
    return pod ? this.prismaToPod(pod) : null;
  }

  /**
   * Get pods by path (might have multiple build files)
   */
  async getPodsByPath(podPath: string): Promise<FantomPod[]> {
    const prisma = getPrismaClient();
    const pods = await prisma.pod.findMany({
      where: { path: podPath },
    });
    return pods.map(this.prismaToPod);
  }

  /**
   * Update a pod
   */
  async updatePod(id: number, input: UpdatePodInput): Promise<FantomPod | null> {
    const prisma = getPrismaClient();

    const existing = await this.getPodById(id);
    if (!existing) return null;

    const pod = await prisma.pod.update({
      where: { id },
      data: {
        name: input.name ?? undefined,
        path: input.path ?? undefined,
        buildFile: input.buildFile ?? undefined,
        description: input.description ?? undefined,
        defaultInstanceId: input.defaultInstanceId !== undefined ? input.defaultInstanceId : undefined,
        compatMinVersion: input.compatMinVersion !== undefined ? input.compatMinVersion : undefined,
        compatMaxVersion: input.compatMaxVersion !== undefined ? input.compatMaxVersion : undefined,
        compatVersions: input.compatVersions !== undefined ? (input.compatVersions ? JSON.stringify(input.compatVersions) : null) : undefined,
      },
    });

    return this.prismaToPod(pod);
  }

  /**
   * Delete a pod
   */
  async deletePod(id: number): Promise<boolean> {
    const prisma = getPrismaClient();

    try {
      await prisma.pod.delete({
        where: { id },
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Discover build files in a pod directory
   */
  discoverBuildFiles(podPath: string): string[] {
    const buildFiles: string[] = [];

    if (!fs.existsSync(podPath)) {
      return buildFiles;
    }

    const files = fs.readdirSync(podPath);
    for (const file of files) {
      if (file.endsWith('.fan') && file.toLowerCase().includes('build')) {
        buildFiles.push(file);
      }
    }

    // Sort with 'build.fan' first if present
    buildFiles.sort((a, b) => {
      if (a === 'build.fan') return -1;
      if (b === 'build.fan') return 1;
      return a.localeCompare(b);
    });

    return buildFiles;
  }

  // ===========================================
  // Compile Log Operations
  // ===========================================

  /**
   * Create a compile log entry (status: running)
   */
  async createCompileLog(podId: number, instanceId: number, buildFile: string): Promise<CompileLog> {
    const prisma = getPrismaClient();

    const log = await prisma.compileLog.create({
      data: {
        podId,
        instanceId,
        buildFile,
        status: 'running',
      },
    });

    return this.prismaToCompileLog(log);
  }

  /**
   * Update compile log with result
   */
  async completeCompileLog(
    id: number,
    status: CompileStatus,
    output: string,
    error: string | null,
    durationMs: number
  ): Promise<CompileLog | null> {
    const prisma = getPrismaClient();

    const log = await prisma.compileLog.update({
      where: { id },
      data: {
        status,
        output,
        error,
        durationMs,
        completedAt: new Date(),
      },
    });

    return this.prismaToCompileLog(log);
  }

  /**
   * Get compile log by ID
   */
  async getCompileLogById(id: number): Promise<CompileLog | null> {
    const prisma = getPrismaClient();
    const log = await prisma.compileLog.findUnique({
      where: { id },
    });
    return log ? this.prismaToCompileLog(log) : null;
  }

  /**
   * Get compile logs for a pod
   */
  async getCompileLogsForPod(podId: number, limit: number = 20): Promise<CompileLog[]> {
    const prisma = getPrismaClient();
    const logs = await prisma.compileLog.findMany({
      where: { podId },
      orderBy: { startedAt: 'desc' },
      take: limit,
    });
    return logs.map(this.prismaToCompileLog);
  }

  /**
   * Get running compilations
   */
  async getRunningCompilations(): Promise<CompileLog[]> {
    const prisma = getPrismaClient();
    const logs = await prisma.compileLog.findMany({
      where: { status: 'running' },
    });
    return logs.map(this.prismaToCompileLog);
  }

  // ===========================================
  // Fantom Project Operations (for code indexing)
  // ===========================================

  /**
   * Create a new Fantom project for code indexing.
   *
   * Refuses to register the same path twice. Schema currently only has
   * `name @unique`, but adding the same directory under two different names
   * silently doubles index storage, splits the call graph across project ids,
   * and double-counts every search hit. Almost always a mistake.
   *
   * Throws a `ProjectPathConflictError` (with the existing project attached)
   * when the path is already registered. Callers can decide how to surface
   * it — admin route returns 409, MCP tool returns a structured error.
   */
  async createProject(input: CreateProjectInput): Promise<FantomProjectRecord> {
    const prisma = getPrismaClient();

    const existing = await prisma.fantomProject.findFirst({
      where: { path: input.path },
    });
    if (existing) {
      throw new ProjectPathConflictError(this.prismaToProject(existing));
    }

    const project = await prisma.fantomProject.create({
      data: {
        name: input.name,
        path: input.path,
        instanceId: input.instanceId || null,
        podName: input.podName || null,
        description: input.description || null,
        autoIndex: input.autoIndex !== false,
        language: input.language || 'fantom',
        parserType: input.parserType || 'regex',
      },
    });

    return this.prismaToProject(project);
  }

  /**
   * Get all Fantom projects
   */
  async getAllProjects(): Promise<FantomProjectRecord[]> {
    const prisma = getPrismaClient();
    const projects = await prisma.fantomProject.findMany({
      orderBy: { name: 'asc' },
    });
    return projects.map(this.prismaToProject);
  }

  /**
   * Get projects that should be auto-indexed
   */
  async getAutoIndexProjects(): Promise<FantomProjectRecord[]> {
    const prisma = getPrismaClient();
    const projects = await prisma.fantomProject.findMany({
      where: { autoIndex: true },
      orderBy: { name: 'asc' },
    });
    return projects.map(this.prismaToProject);
  }

  /**
   * Enable autoIndex for all projects with valid source paths
   * Returns the number of projects updated
   */
  async enableAutoIndexForAll(): Promise<number> {
    const prisma = getPrismaClient();
    const result = await prisma.fantomProject.updateMany({
      where: { autoIndex: false },
      data: { autoIndex: true }
    });
    return result.count;
  }

  /**
   * Get project by ID
   */
  async getProjectById(id: number): Promise<FantomProjectRecord | null> {
    const prisma = getPrismaClient();
    const project = await prisma.fantomProject.findUnique({
      where: { id },
    });
    return project ? this.prismaToProject(project) : null;
  }

  /**
   * Get project by name
   */
  async getProjectByName(name: string): Promise<FantomProjectRecord | null> {
    const prisma = getPrismaClient();
    const project = await prisma.fantomProject.findUnique({
      where: { name },
    });
    return project ? this.prismaToProject(project) : null;
  }

  /**
   * Get projects for an instance
   */
  async getProjectsByInstance(instanceId: number): Promise<FantomProjectRecord[]> {
    const prisma = getPrismaClient();
    const projects = await prisma.fantomProject.findMany({
      where: { instanceId },
      orderBy: { name: 'asc' },
    });
    return projects.map(this.prismaToProject);
  }

  /**
   * Update a project
   */
  async updateProject(id: number, input: UpdateProjectInput): Promise<FantomProjectRecord | null> {
    const prisma = getPrismaClient();

    const existing = await this.getProjectById(id);
    if (!existing) return null;

    const project = await prisma.fantomProject.update({
      where: { id },
      data: {
        name: input.name ?? undefined,
        path: input.path ?? undefined,
        instanceId: input.instanceId !== undefined ? input.instanceId : undefined,
        podName: input.podName ?? undefined,
        description: input.description ?? undefined,
        autoIndex: input.autoIndex !== undefined ? input.autoIndex : undefined,
        language: input.language ?? undefined,
        parserType: input.parserType ?? undefined,
      },
    });

    return this.prismaToProject(project);
  }

  /**
   * Update project index statistics
   */
  async updateProjectIndexStats(id: number, functionCount: number, typeCount: number): Promise<void> {
    const prisma = getPrismaClient();

    await prisma.fantomProject.update({
      where: { id },
      data: {
        functionCount,
        typeCount,
        lastIndexed: new Date(),
      },
    });
  }

  /**
   * Delete a project
   */
  async deleteProject(id: number): Promise<boolean> {
    const prisma = getPrismaClient();

    try {
      await prisma.fantomProject.delete({
        where: { id },
      });
      return true;
    } catch {
      return false;
    }
  }

  // ===========================================
  // Documentation Index Operations
  // ===========================================

  /**
   * Create or update a documentation index entry
   */
  async upsertDocIndex(
    instanceId: number,
    podName: string,
    docPath: string,
    itemCount: number,
    version?: string,
    cacheFile?: string
  ): Promise<DocIndex> {
    const prisma = getPrismaClient();

    return await prisma.docIndex.upsert({
      where: {
        instanceId_podName: { instanceId, podName },
      },
      create: {
        instanceId,
        podName,
        docPath,
        itemCount,
        version: version || null,
        cacheFile: cacheFile || null,
      },
      update: {
        docPath,
        itemCount,
        version: version || null,
        cacheFile: cacheFile || null,
        lastIndexed: new Date(),
      },
    });
  }

  /**
   * Get documentation indexes for an instance
   */
  async getDocIndexesForInstance(instanceId: number): Promise<DocIndex[]> {
    const prisma = getPrismaClient();
    return await prisma.docIndex.findMany({
      where: { instanceId },
      orderBy: { podName: 'asc' },
    });
  }

  /**
   * Get documentation index by instance and pod
   */
  async getDocIndex(instanceId: number, podName: string): Promise<DocIndex | null> {
    const prisma = getPrismaClient();
    return await prisma.docIndex.findUnique({
      where: {
        instanceId_podName: { instanceId, podName },
      },
    });
  }

  /**
   * Delete documentation index for an instance
   */
  async deleteDocIndexesForInstance(instanceId: number): Promise<number> {
    const prisma = getPrismaClient();
    const result = await prisma.docIndex.deleteMany({
      where: { instanceId },
    });
    return result.count;
  }

  // ===========================================
  // Settings Operations
  // ===========================================

  /**
   * Get a setting value
   */
  async getSetting(key: string): Promise<string | null> {
    const prisma = getPrismaClient();
    const setting = await prisma.setting.findUnique({
      where: { key },
    });
    return setting?.value || null;
  }

  /**
   * Set a setting value
   */
  async setSetting(key: string, value: string): Promise<void> {
    const prisma = getPrismaClient();
    await prisma.setting.upsert({
      where: { key },
      create: { key, value },
      update: { value },
    });
  }

  /**
   * Get active instance ID
   */
  async getActiveInstanceId(): Promise<number | null> {
    const value = await this.getSetting('active_instance_id');
    return value ? parseInt(value, 10) : null;
  }

  /**
   * Set active instance ID
   */
  async setActiveInstanceId(id: number | null): Promise<void> {
    await this.setSetting('active_instance_id', id?.toString() || '');
  }

  /**
   * Get active instance
   */
  async getActiveInstance(): Promise<FantomInstance | null> {
    const id = await this.getActiveInstanceId();
    return id ? this.getInstanceById(id) : null;
  }

  /**
   * Get all settings
   */
  async getSettings(): Promise<FantomInstanceSettings> {
    const activeInstanceId = await this.getActiveInstanceId();
    const lastCompiledPodId = await this.getSetting('last_compiled_pod_id');

    return {
      activeInstanceId,
      lastCompiledPodId: lastCompiledPodId ? parseInt(lastCompiledPodId, 10) : null,
    };
  }

  // ===========================================
  // Fantom Source Folder Settings
  // ===========================================

  /**
   * Get the Fantom source folder setting
   */
  async getFantomSourceFolder(): Promise<string | null> {
    return this.getSetting('fantom_source_folder');
  }

  /**
   * Set the Fantom source folder setting
   */
  async setFantomSourceFolder(folderPath: string): Promise<void> {
    await this.setSetting('fantom_source_folder', folderPath);
  }

  // ===========================================
  // Helper Methods
  // ===========================================

  /**
   * Detect the fan executable path based on instance type
   */
  private detectFanExecutable(instancePath: string): string {
    // Common locations for fan executable
    const possiblePaths = [
      'bin/fan',
      'fan',
      'bin/fan.exe',
      'fan.exe'
    ];

    for (const p of possiblePaths) {
      const fullPath = path.join(instancePath, p);
      if (fs.existsSync(fullPath)) {
        return p;
      }
    }

    // Default to bin/fan
    return 'bin/fan';
  }

  /**
   * Validate that an instance path has a working fan executable
   */
  private validateInstancePath(instancePath: string, fanExecutable: string): boolean {
    if (!fs.existsSync(instancePath)) {
      return false;
    }

    const fanPath = path.join(instancePath, fanExecutable);
    return fs.existsSync(fanPath);
  }

  /**
   * Convert Prisma Instance to FantomInstance
   */
  private prismaToInstance(instance: Instance): FantomInstance {
    return {
      id: instance.id,
      name: instance.name,
      path: instance.path,
      type: instance.type as FantomInstance['type'],
      version: instance.version || undefined,
      fanExecutable: instance.fanExecutable || 'bin/fan',
      description: instance.description || undefined,
      sourcePath: instance.sourcePath || undefined,
      fantomVersion: instance.fantomVersion || undefined,
      fantomSourcePath: instance.fantomSourcePath || undefined,
      docSourceInstanceId: instance.docSourceInstanceId || undefined,
      isValid: instance.isValid,
      createdAt: instance.createdAt.toISOString(),
      updatedAt: instance.updatedAt.toISOString(),
    };
  }

  /**
   * Convert Prisma Pod to FantomPod
   */
  private prismaToPod(pod: Pod): FantomPod {
    // Parse compatVersions from JSON string to string array
    let compatVersions: string[] | undefined;
    if (pod.compatVersions) {
      try {
        compatVersions = JSON.parse(pod.compatVersions);
      } catch {
        compatVersions = undefined;
      }
    }

    return {
      id: pod.id,
      name: pod.name,
      path: pod.path,
      buildFile: pod.buildFile,
      description: pod.description || undefined,
      defaultInstanceId: pod.defaultInstanceId || undefined,
      compatMinVersion: pod.compatMinVersion || undefined,
      compatMaxVersion: pod.compatMaxVersion || undefined,
      compatVersions,
      createdAt: pod.createdAt.toISOString(),
      updatedAt: pod.updatedAt.toISOString(),
    };
  }

  /**
   * Convert Prisma CompileLog to CompileLog
   */
  private prismaToCompileLog(log: PrismaCompileLog): CompileLog {
    return {
      id: log.id,
      podId: log.podId,
      instanceId: log.instanceId,
      buildFile: log.buildFile,
      status: log.status as CompileStatus,
      output: log.output || undefined,
      error: log.error || undefined,
      durationMs: log.durationMs || undefined,
      startedAt: log.startedAt.toISOString(),
      completedAt: log.completedAt?.toISOString(),
    };
  }

  /**
   * Convert Prisma FantomProject to FantomProjectRecord
   */
  private prismaToProject(project: FantomProject): FantomProjectRecord {
    return {
      id: project.id,
      name: project.name,
      path: project.path,
      instanceId: project.instanceId || undefined,
      buildId: project.buildId || undefined,
      podName: project.podName || undefined,
      description: project.description || undefined,
      functionCount: project.functionCount,
      typeCount: project.typeCount,
      lastIndexed: project.lastIndexed?.toISOString(),
      autoIndex: project.autoIndex,
      language: project.language || 'fantom',
      parserType: project.parserType || 'regex',
      createdAt: project.createdAt.toISOString(),
      updatedAt: project.updatedAt.toISOString(),
    };
  }

  /**
   * Get database info
   */
  getDatabaseInfo(): { path: string; sizeBytes: number } {
    const dbPath = getCachePath('fantom.db');
    const stats = fs.existsSync(dbPath) ? fs.statSync(dbPath) : null;
    return {
      path: dbPath,
      sizeBytes: stats?.size || 0
    };
  }

  /**
   * Close the database connection
   */
  async close(): Promise<void> {
    // Prisma client is managed globally, don't disconnect here
  }

  /**
   * Get the documentation path for an instance
   * Returns the detected doc path based on instance type/version
   *
   * Path detection order based on instance type:
   * - Haxall: {path}/home/doc
   * - SkySpark 4.x: {path}/var/doc
   * - SkySpark 3.x / Fantom: {path}/doc
   */
  getDocPathForInstance(instance: FantomInstance): string | null {
    const basePath = instance.path;

    // Check for Haxall style (home/doc/)
    // Prioritize this for haxall type instances
    if (instance.type === 'haxall') {
      const homeDocPath = path.join(basePath, 'home', 'doc');
      if (fs.existsSync(homeDocPath)) {
        return homeDocPath;
      }
    }

    // Check for SkySpark 4.x style (var/doc/)
    const varDocPath = path.join(basePath, 'var', 'doc');
    if (fs.existsSync(varDocPath)) {
      return varDocPath;
    }

    // Check for SkySpark 3.x / Fantom style (doc/)
    const docPath = path.join(basePath, 'doc');
    if (fs.existsSync(docPath)) {
      return docPath;
    }

    // Fallback: Check home/doc for any type (in case instance type is not set correctly)
    const homeDocPath = path.join(basePath, 'home', 'doc');
    if (fs.existsSync(homeDocPath)) {
      return homeDocPath;
    }

    return null;
  }

  // ===========================================
  // Fantom Build CRUD Operations
  // ===========================================

  /**
   * Create a new Fantom build entry
   */
  async createFantomBuild(input: CreateFantomBuildInput): Promise<FantomBuild> {
    const prisma = getPrismaClient();

    const build = await prisma.fantomBuild.create({
      data: {
        version: input.version,
        path: input.path,
        hasSource: input.hasSource ?? false,
        isActive: input.isActive ?? true,
      },
    });

    return this.prismaToFantomBuild(build);
  }

  /**
   * Get all Fantom builds
   */
  async getAllFantomBuilds(): Promise<FantomBuild[]> {
    const prisma = getPrismaClient();
    const builds = await prisma.fantomBuild.findMany({
      orderBy: { version: 'desc' },
    });
    return builds.map(this.prismaToFantomBuild);
  }

  /**
   * Get Fantom build by ID
   */
  async getFantomBuildById(id: number): Promise<FantomBuild | null> {
    const prisma = getPrismaClient();
    const build = await prisma.fantomBuild.findUnique({
      where: { id },
    });
    return build ? this.prismaToFantomBuild(build) : null;
  }

  /**
   * Get Fantom build by version
   */
  async getFantomBuildByVersion(version: string): Promise<FantomBuild | null> {
    const prisma = getPrismaClient();
    const build = await prisma.fantomBuild.findUnique({
      where: { version },
    });
    return build ? this.prismaToFantomBuild(build) : null;
  }

  /**
   * Update a Fantom build
   */
  async updateFantomBuild(id: number, input: UpdateFantomBuildInput): Promise<FantomBuild | null> {
    const prisma = getPrismaClient();

    const existing = await this.getFantomBuildById(id);
    if (!existing) return null;

    const build = await prisma.fantomBuild.update({
      where: { id },
      data: {
        path: input.path ?? undefined,
        hasSource: input.hasSource ?? undefined,
        isActive: input.isActive ?? undefined,
      },
    });

    return this.prismaToFantomBuild(build);
  }

  /**
   * Update Fantom build index stats
   */
  async updateFantomBuildIndexStats(
    id: number,
    stats: { podCount: number; functionCount: number; typeCount: number }
  ): Promise<void> {
    const prisma = getPrismaClient();

    await prisma.fantomBuild.update({
      where: { id },
      data: {
        podCount: stats.podCount,
        functionCount: stats.functionCount,
        typeCount: stats.typeCount,
        lastIndexed: new Date(),
      },
    });
  }

  /**
   * Delete a Fantom build and its associated projects
   */
  async deleteFantomBuild(id: number): Promise<boolean> {
    const prisma = getPrismaClient();

    const existing = await this.getFantomBuildById(id);
    if (!existing) return false;

    // Delete associated projects first
    await prisma.fantomProject.deleteMany({
      where: { buildId: id },
    });

    await prisma.fantomBuild.delete({
      where: { id },
    });

    return true;
  }

  /**
   * Get projects for a Fantom build
   */
  async getProjectsForBuild(buildId: number): Promise<FantomProjectRecord[]> {
    const prisma = getPrismaClient();
    const projects = await prisma.fantomProject.findMany({
      where: { buildId },
      orderBy: { name: 'asc' },
    });
    return projects.map(this.prismaToProject);
  }

  /**
   * Create a project for a Fantom build pod
   * Uses naming convention: fantom.{version}.{podName}
   */
  async createProjectForBuild(
    buildId: number,
    podName: string,
    podPath: string,
    version: string
  ): Promise<FantomProjectRecord> {
    const prisma = getPrismaClient();

    // Use naming convention: fantom.{version}.{podName}
    const projectName = `fantom.${version}.${podName}`;

    // Check if project already exists
    const existing = await prisma.fantomProject.findUnique({
      where: { name: projectName },
    });

    if (existing) {
      // Update existing project
      const project = await prisma.fantomProject.update({
        where: { name: projectName },
        data: {
          path: podPath,
          buildId,
          podName,
        },
      });
      return this.prismaToProject(project);
    }

    // Create new project
    const project = await prisma.fantomProject.create({
      data: {
        name: projectName,
        path: podPath,
        buildId,
        podName,
        autoIndex: true,
      },
    });

    return this.prismaToProject(project);
  }

  /**
   * Convert Prisma FantomBuild to FantomBuild
   */
  private prismaToFantomBuild(build: PrismaFantomBuild): FantomBuild {
    return {
      id: build.id,
      version: build.version,
      path: build.path,
      hasSource: build.hasSource,
      podCount: build.podCount,
      functionCount: build.functionCount,
      typeCount: build.typeCount,
      lastIndexed: build.lastIndexed?.toISOString(),
      isActive: build.isActive,
      createdAt: build.createdAt.toISOString(),
      updatedAt: build.updatedAt.toISOString(),
    };
  }
}

// Singleton instance
let fantomDatabaseInstance: FantomDatabase | null = null;

/**
 * One-shot startup migration: rewrite project paths starting with `~/` to
 * their absolute form. Pre-fix rows scan zero files because the walker does
 * not expand `~`. Idempotent — re-running is a no-op once paths are absolute.
 */
export async function migrateProjectPaths(): Promise<number> {
  const prisma = getPrismaClient();
  const os = await import('os');
  const path = await import('path');
  const rows = await prisma.fantomProject.findMany({
    where: { path: { startsWith: '~' } },
  });
  let rewritten = 0;
  for (const row of rows) {
    if (!row.path.startsWith('~')) continue;
    const expanded = path.resolve(row.path.replace(/^~(?=$|[/\\])/, os.homedir()));
    if (expanded === row.path) continue;
    await prisma.fantomProject.update({ where: { id: row.id }, data: { path: expanded } });
    console.log(`[migrate] project ${row.id} (${row.name}): "${row.path}" → "${expanded}"`);
    rewritten++;
  }
  return rewritten;
}

/**
 * Get the singleton FantomDatabase instance
 */
export function getFantomDatabase(_dbPath?: string): FantomDatabase {
  if (!fantomDatabaseInstance) {
    fantomDatabaseInstance = new FantomDatabase();
  }
  return fantomDatabaseInstance;
}

/**
 * Reset the singleton instance (useful for testing)
 */
export async function resetFantomDatabase(): Promise<void> {
  if (fantomDatabaseInstance) {
    await fantomDatabaseInstance.close();
    fantomDatabaseInstance = null;
  }
}
