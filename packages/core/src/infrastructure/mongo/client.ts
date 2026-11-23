import { MongoClient } from "mongodb";
import { InfrastructureUnavailableError } from "../../domain/errors.js";
import type { MongoStore } from "./collections.js";

export const DEFAULT_DATABASE = "agent_skeleton";

export interface ConnectMongoOptions {
  appName: string;
  /** Overrides the database named in the URI. Tests use a unique name per run. */
  databaseName?: string;
  serverSelectionTimeoutMS?: number;
}

/**
 * Connects and checks that the server answers. The database is the one named in the URI
 * path, or `agent_skeleton` when the URI names none.
 */
export async function connectMongo(uri: string, options: ConnectMongoOptions): Promise<MongoStore> {
  const client = new MongoClient(uri, {
    appName: options.appName,
    serverSelectionTimeoutMS: options.serverSelectionTimeoutMS ?? 10_000,
  });
  try {
    await client.connect();
    const db = client.db(options.databaseName ?? (client.options.dbName || DEFAULT_DATABASE));
    await db.command({ ping: 1 });
    return { client, db };
  } catch (error) {
    await client.close().catch(() => undefined);
    // The URI may contain credentials, so it is not part of the message.
    throw new InfrastructureUnavailableError(
      "MongoDB is not reachable. Check MONGODB_URI and that Mongo is running.",
      { cause: error },
    );
  }
}
