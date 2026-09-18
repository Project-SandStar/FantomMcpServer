/**
 * User Store for Authentication
 *
 * Provides multi-user support with secure password hashing using PBKDF2-SHA512.
 * Stores user data in a JSON file (config/users.json).
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

// ============================================
// Types
// ============================================

export type UserRole = 'admin' | 'user';

export interface User {
  id: string;
  username: string;
  passwordHash: string;  // Format: "salt:hash"
  role: UserRole;
  createdAt: string;     // ISO timestamp
  lastLogin?: string;    // ISO timestamp
}

export interface UserPublic {
  id: string;
  username: string;
  role: UserRole;
  createdAt: string;
  lastLogin?: string;
}

interface UsersFile {
  version: number;
  users: User[];
}

// ============================================
// Password Hashing (PBKDF2-SHA512)
// ============================================

const PBKDF2_ITERATIONS = 100000;
const PBKDF2_KEY_LENGTH = 64;
const PBKDF2_DIGEST = 'sha512';
const SALT_LENGTH = 16;

/**
 * Hash a password using PBKDF2-SHA512
 * @param password Plain text password
 * @param existingSalt Optional salt for verification
 * @returns Object containing the combined hash string (salt:hash) and the salt
 */
function hashPassword(password: string, existingSalt?: string): { hash: string; salt: string } {
  const salt = existingSalt || crypto.randomBytes(SALT_LENGTH).toString('hex');
  const derivedKey = crypto.pbkdf2Sync(
    password,
    salt,
    PBKDF2_ITERATIONS,
    PBKDF2_KEY_LENGTH,
    PBKDF2_DIGEST
  );
  const hash = derivedKey.toString('hex');
  return { hash: `${salt}:${hash}`, salt };
}

/**
 * Verify a password against a stored hash
 * @param password Plain text password to verify
 * @param storedHash Stored hash in format "salt:hash"
 * @returns true if password matches
 */
function verifyPassword(password: string, storedHash: string): boolean {
  const [salt, expectedHash] = storedHash.split(':');
  if (!salt || !expectedHash) return false;

  const { hash: computedHash } = hashPassword(password, salt);

  // Use timing-safe comparison to prevent timing attacks
  const expected = Buffer.from(storedHash, 'utf-8');
  const actual = Buffer.from(computedHash, 'utf-8');

  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(expected, actual);
}

// ============================================
// User Store Class
// ============================================

export class UserStore {
  private users: Map<string, User> = new Map();
  private configPath: string;

  constructor(configDir: string) {
    this.configPath = path.join(configDir, 'users.json');
    this.loadUsers();
  }

  /**
   * Load users from the JSON file
   */
  private loadUsers(): void {
    if (fs.existsSync(this.configPath)) {
      try {
        const data: UsersFile = JSON.parse(fs.readFileSync(this.configPath, 'utf-8'));
        for (const user of data.users || []) {
          this.users.set(user.username.toLowerCase(), user);
        }
        console.log(`[UserStore] Loaded ${this.users.size} users from ${this.configPath}`);
      } catch (error) {
        console.error('[UserStore] Error loading users file, creating default user:', error);
        this.initializeDefaultUser();
      }
    } else {
      console.log('[UserStore] No users file found, creating default admin user');
      this.initializeDefaultUser();
    }
  }

  /**
   * Create the default admin user
   */
  private initializeDefaultUser(): void {
    const defaultUser: User = {
      id: crypto.randomUUID(),
      username: 'admin',
      passwordHash: hashPassword('admin').hash,
      role: 'admin',
      createdAt: new Date().toISOString(),
    };
    this.users.set('admin', defaultUser);
    this.saveUsers();
    console.log('[UserStore] Created default admin user (username: admin, password: admin)');
  }

  /**
   * Save users to the JSON file
   */
  private saveUsers(): void {
    const data: UsersFile = {
      version: 1,
      users: Array.from(this.users.values()),
    };

    // Ensure config directory exists
    const configDir = path.dirname(this.configPath);
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }

    fs.writeFileSync(this.configPath, JSON.stringify(data, null, 2), 'utf-8');
  }

  /**
   * Convert a User to UserPublic (removes sensitive fields)
   */
  private toPublic(user: User): UserPublic {
    return {
      id: user.id,
      username: user.username,
      role: user.role,
      createdAt: user.createdAt,
      lastLogin: user.lastLogin,
    };
  }

  // ============================================
  // Authentication
  // ============================================

  /**
   * Authenticate a user with username and password
   * @returns User object if valid, null otherwise
   */
  authenticate(username: string, password: string): User | null {
    const user = this.users.get(username.toLowerCase());
    if (!user) {
      return null;
    }

    if (!verifyPassword(password, user.passwordHash)) {
      return null;
    }

    // Update last login timestamp
    user.lastLogin = new Date().toISOString();
    this.saveUsers();

    return user;
  }

  /**
   * Authenticate and return public user info (for API responses)
   */
  authenticatePublic(username: string, password: string): UserPublic | null {
    const user = this.authenticate(username, password);
    return user ? this.toPublic(user) : null;
  }

  // ============================================
  // User CRUD Operations
  // ============================================

  /**
   * Get all users (public info only)
   */
  getAllUsers(): UserPublic[] {
    return Array.from(this.users.values()).map(u => this.toPublic(u));
  }

  /**
   * Get a user by username (public info only)
   */
  getUser(username: string): UserPublic | null {
    const user = this.users.get(username.toLowerCase());
    return user ? this.toPublic(user) : null;
  }

  /**
   * Check if a user exists
   */
  userExists(username: string): boolean {
    return this.users.has(username.toLowerCase());
  }

  /**
   * Create a new user
   * @throws Error if username already exists or validation fails
   */
  createUser(username: string, password: string, role: UserRole = 'user'): UserPublic {
    // Validate username
    if (!username || username.length < 3) {
      throw new Error('Username must be at least 3 characters');
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(username)) {
      throw new Error('Username can only contain letters, numbers, underscores, and hyphens');
    }

    // Validate password
    if (!password || password.length < 4) {
      throw new Error('Password must be at least 4 characters');
    }

    // Check for duplicates
    if (this.users.has(username.toLowerCase())) {
      throw new Error('User already exists');
    }

    const user: User = {
      id: crypto.randomUUID(),
      username: username.toLowerCase(),
      passwordHash: hashPassword(password).hash,
      role,
      createdAt: new Date().toISOString(),
    };

    this.users.set(username.toLowerCase(), user);
    this.saveUsers();

    console.log(`[UserStore] Created user: ${username} (role: ${role})`);
    return this.toPublic(user);
  }

  /**
   * Update a user's password
   * @throws Error if validation fails
   */
  updatePassword(username: string, newPassword: string): boolean {
    if (!newPassword || newPassword.length < 4) {
      throw new Error('Password must be at least 4 characters');
    }

    const user = this.users.get(username.toLowerCase());
    if (!user) {
      return false;
    }

    user.passwordHash = hashPassword(newPassword).hash;
    this.saveUsers();

    console.log(`[UserStore] Updated password for user: ${username}`);
    return true;
  }

  /**
   * Update a user's role
   * @throws Error if trying to demote the last admin
   */
  updateRole(username: string, newRole: UserRole): boolean {
    const user = this.users.get(username.toLowerCase());
    if (!user) {
      return false;
    }

    // Prevent demoting the last admin
    if (user.role === 'admin' && newRole === 'user') {
      const adminCount = Array.from(this.users.values()).filter(u => u.role === 'admin').length;
      if (adminCount <= 1) {
        throw new Error('Cannot demote the last admin user');
      }
    }

    user.role = newRole;
    this.saveUsers();

    console.log(`[UserStore] Updated role for user: ${username} to ${newRole}`);
    return true;
  }

  /**
   * Delete a user
   * @throws Error if trying to delete the last admin
   */
  deleteUser(username: string): boolean {
    const user = this.users.get(username.toLowerCase());
    if (!user) {
      return false;
    }

    // Prevent deleting the last admin
    if (user.role === 'admin') {
      const adminCount = Array.from(this.users.values()).filter(u => u.role === 'admin').length;
      if (adminCount <= 1) {
        throw new Error('Cannot delete the last admin user');
      }
    }

    this.users.delete(username.toLowerCase());
    this.saveUsers();

    console.log(`[UserStore] Deleted user: ${username}`);
    return true;
  }

  // ============================================
  // Utility Methods
  // ============================================

  /**
   * Get the count of admin users
   */
  getAdminCount(): number {
    return Array.from(this.users.values()).filter(u => u.role === 'admin').length;
  }

  /**
   * Get the total user count
   */
  getUserCount(): number {
    return this.users.size;
  }

  /**
   * Reload users from file (useful if file was modified externally)
   */
  reload(): void {
    this.users.clear();
    this.loadUsers();
  }
}

// ============================================
// Singleton Instance
// ============================================

let userStoreInstance: UserStore | null = null;

/**
 * Get the UserStore singleton instance
 * @param configDir Directory for the users.json file (only used on first call)
 */
export function getUserStore(configDir?: string): UserStore {
  if (!userStoreInstance) {
    const dir = configDir || path.join(process.cwd(), 'config');
    userStoreInstance = new UserStore(dir);
  }
  return userStoreInstance;
}

/**
 * Reset the UserStore instance (for testing)
 */
export function resetUserStore(): void {
  userStoreInstance = null;
}
