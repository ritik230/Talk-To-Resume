import { MongoClient } from "mongodb";

let client;
let db;
let usersCollection;
let candidatesCollection;
let sessionsCollection;
let retrievalMetricsCollection;
export async function connectDatabase() {
  const mongoUri = process.env.MONGODB_URI;
  const databaseName = process.env.MONGODB_DB || "talk_to_resume";
  if (!mongoUri) {
    throw new Error("MONGODB_URI is not configured.");
  }

  client = new MongoClient(mongoUri, {
    serverSelectionTimeoutMS: Number(process.env.MONGODB_SERVER_SELECTION_TIMEOUT_MS || 10000),
    connectTimeoutMS: Number(process.env.MONGODB_CONNECT_TIMEOUT_MS || 10000),
    socketTimeoutMS: Number(process.env.MONGODB_SOCKET_TIMEOUT_MS || 20000),
    maxPoolSize: Number(process.env.MONGODB_MAX_POOL_SIZE || 20)
  });

  try {
    await client.connect();
    await client.db(databaseName).command({ ping: 1 });
  } catch (error) {
    await safeCloseClient();
    throw buildMongoConnectionError(error);
  }

  db = client.db(databaseName);
  usersCollection = db.collection("users");
  candidatesCollection = db.collection("candidates");
  sessionsCollection = db.collection("sessions");
  retrievalMetricsCollection = db.collection("retrieval_metrics");

  await usersCollection.createIndex({ email: 1 }, { unique: true });
  await candidatesCollection.createIndex({ userId: 1 }, { unique: true });
  await candidatesCollection.createIndex({ name: 1 });
  await candidatesCollection.createIndex({ "metadata.role": 1 });
  await candidatesCollection.createIndex({ "metadata.location": 1 });
  await sessionsCollection.createIndex({ sessionId: 1, userId: 1 }, { unique: true });
  await sessionsCollection.createIndex({ updatedAt: -1 });
  await retrievalMetricsCollection.createIndex({ createdAt: -1 });
  await retrievalMetricsCollection.createIndex({ sessionId: 1, createdAt: -1 });
}

export function getCollections() {
  if (!usersCollection || !candidatesCollection) {
    throw new Error("Database is not connected.");
  }

  return {
    db,
    usersCollection,
    candidatesCollection,
    sessionsCollection,
    retrievalMetricsCollection
  };
}

export async function closeDatabase() {
  await safeCloseClient();

  client = null;
  db = null;
  usersCollection = null;
  candidatesCollection = null;
  sessionsCollection = null;
  retrievalMetricsCollection = null;
}

async function safeCloseClient() {
  if (!client) {
    return;
  }

  try {
    await client.close();
  } catch {
    // Ignore close failures while cleaning up a broken connection.
  }
}

function buildMongoConnectionError(error) {
  const message = error instanceof Error ? error.message : String(error || "Unknown MongoDB error.");
  const timeoutHint = /timed out|server selection|econnreset|replicasetnoprimary/i.test(message)
    ? " Check MongoDB Atlas network access, cluster health, and your current IP allowlist."
    : "";
  return new Error(`Failed to connect to MongoDB.${timeoutHint} Details: ${message}`);
}
