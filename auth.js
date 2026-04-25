import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { ObjectId } from "mongodb";
import { getCollections } from "./db.js";

export function validateAuthConfiguration() {
  if (!process.env.JWT_SECRET || !String(process.env.JWT_SECRET).trim()) {
    throw new Error("JWT_SECRET is required and must be configured before starting the server.");
  }
}

export async function createUser({ name, email, password, role }) {
  const { usersCollection } = getCollections();
  const normalizedEmail = normalizeEmail(email);
  const existing = await usersCollection.findOne({ email: normalizedEmail });
  if (existing) {
    throw new Error("An account with this email already exists.");
  }

  const passwordHash = await bcrypt.hash(String(password), 10);
  const now = new Date();
  const result = await usersCollection.insertOne({
    name: String(name).trim(),
    email: normalizedEmail,
    passwordHash,
    role,
    createdAt: now
  });

  return {
    id: result.insertedId.toString(),
    name: String(name).trim(),
    email: normalizedEmail,
    role
  };
}

export async function verifyCredentials(email, password) {
  const { usersCollection } = getCollections();
  const userDoc = await usersCollection.findOne({ email: normalizeEmail(email) });
  if (!userDoc) {
    throw new Error("Invalid email or password.");
  }

  const valid = await bcrypt.compare(String(password), userDoc.passwordHash);
  if (!valid) {
    throw new Error("Invalid email or password.");
  }

  return projectUser(userDoc);
}

export async function hydrateUserFromToken(id) {
  const { usersCollection } = getCollections();
  const userDoc = await usersCollection.findOne({ _id: new ObjectId(id) });
  if (!userDoc) {
    throw new Error("User not found.");
  }
  return projectUser(userDoc);
}

export function signUserToken(user) {
  const jwtSecret = getJwtSecret();
  return jwt.sign(
    {
      sub: user.id,
      name: user.name,
      email: user.email,
      role: user.role
    },
    jwtSecret,
    { expiresIn: "7d" }
  );
}

export function requireAuth(req, res, next) {
  const jwtSecret = getJwtSecret();
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) {
    res.status(401).json({ error: "Authentication required." });
    return;
  }

  try {
    const payload = jwt.verify(token, jwtSecret);
    req.user = {
      id: String(payload.sub || ""),
      name: String(payload.name || ""),
      email: String(payload.email || ""),
      role: String(payload.role || "")
    };
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired token." });
  }
}

export function requireRole(expectedRole) {
  return (req, res, next) => {
    if (req.user?.role !== expectedRole) {
      res.status(403).json({ error: `${expectedRole} access required.` });
      return;
    }
    next();
  };
}

function projectUser(userDoc) {
  return {
    id: userDoc._id.toString(),
    name: userDoc.name,
    email: userDoc.email,
    role: userDoc.role
  };
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function getJwtSecret() {
  const jwtSecret = String(process.env.JWT_SECRET || "").trim();
  if (!jwtSecret) {
    throw new Error("JWT_SECRET is required and must be configured before handling authenticated requests.");
  }
  return jwtSecret;
}
