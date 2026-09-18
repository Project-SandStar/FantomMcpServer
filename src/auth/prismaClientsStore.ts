/**
 * Prisma-backed OAuth Clients Store
 *
 * Implements the OAuthRegisteredClientsStore interface from MCP SDK
 * using Prisma to persist OAuth clients to the database.
 */

import { PrismaClient } from '@prisma/client';
import { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import { generateClientId, generateClientSecret } from './tokenUtils.js';

export class PrismaClientsStore implements OAuthRegisteredClientsStore {
  constructor(private prisma: PrismaClient) {}

  /**
   * Get a registered client by its client ID
   */
  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    const client = await this.prisma.oAuthClient.findUnique({
      where: { clientId },
    });

    if (!client) return undefined;

    return this.toClientInfo(client);
  }

  /**
   * Register a new OAuth client (dynamic client registration)
   */
  async registerClient(
    clientData: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>
  ): Promise<OAuthClientInformationFull> {
    const clientId = generateClientId();
    const issuedAt = Math.floor(Date.now() / 1000);

    // Check if this is a public client (no client secret needed)
    // Public clients use token_endpoint_auth_method: 'none'
    const isPublicClient = (clientData as { token_endpoint_auth_method?: string }).token_endpoint_auth_method === 'none';
    const clientSecret = isPublicClient ? null : generateClientSecret();

    // Parse redirect URIs from the input - convert to strings for storage
    const redirectUris: string[] = (clientData.redirect_uris as unknown as Array<string | URL>).map((uri) =>
      typeof uri === 'string' ? uri : String(uri)
    );

    const client = await this.prisma.oAuthClient.create({
      data: {
        clientId,
        clientSecret,
        clientName: clientData.client_name || null,
        redirectUris: JSON.stringify(redirectUris),
        scope: clientData.scope || null,
      },
    });

    // Return URIs in the same format as the SDK expects
    const storedUris = JSON.parse(client.redirectUris) as string[];
    return {
      client_id: client.clientId,
      client_secret: client.clientSecret || undefined,
      client_id_issued_at: issuedAt,
      client_name: client.clientName || undefined,
      redirect_uris: storedUris as unknown as OAuthClientInformationFull['redirect_uris'],
      scope: client.scope || undefined,
    };
  }

  /**
   * Delete an OAuth client
   */
  async deleteClient(clientId: string): Promise<boolean> {
    try {
      await this.prisma.oAuthClient.delete({
        where: { clientId },
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get all registered clients
   */
  async getAllClients(): Promise<OAuthClientInformationFull[]> {
    const clients = await this.prisma.oAuthClient.findMany({
      orderBy: { createdAt: 'desc' },
    });

    return clients.map(client => this.toClientInfo(client));
  }

  /**
   * Convert a Prisma OAuthClient record to OAuthClientInformationFull
   */
  private toClientInfo(client: {
    clientId: string;
    clientSecret: string | null;
    clientName: string | null;
    redirectUris: string;
    scope: string | null;
    createdAt: Date;
  }): OAuthClientInformationFull {
    const redirectUriStrings = JSON.parse(client.redirectUris) as string[];

    return {
      client_id: client.clientId,
      client_secret: client.clientSecret || undefined,
      client_id_issued_at: Math.floor(client.createdAt.getTime() / 1000),
      client_name: client.clientName || undefined,
      redirect_uris: redirectUriStrings as unknown as OAuthClientInformationFull['redirect_uris'],
      scope: client.scope || undefined,
    };
  }
}
