import { instrument } from "@fiberplane/hono-otel";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import * as schema from "./db/schema";
import { createFiberplane, createOpenAPISpec } from "@fiberplane/hono";

type Bindings = {
  DB: D1Database;
  BUCKET: R2Bucket;
  AI: Ai;
};

const app = new Hono<{ Bindings: Bindings }>();

app.get("/", (c) => {
  return c.text("Honc from above! ☁️🪿");
});

app.get("/api/users", async (c) => {
  const db = drizzle(c.env.DB);
  const users = await db.select().from(schema.users);
  return c.json({ users });
});

app.post("/api/user", async (c) => {
  const db = drizzle(c.env.DB);
  const r2 = c.env.BUCKET;
  const formData = await c.req.formData();
  const name = formData.get("name");
  const email = formData.get("email");
  const profilePic = formData.get("profile-pic");

  if (!name || !email) {
    return c.json({ error: "Name and email are required" }, 400);
  }

  let thumbnailPath = "";
  // Type guard to check if profilePic is a File-like object
  const isFile = (value: unknown): value is { name: string } => 
    value !== null && 
    typeof value === 'object' && 
    'name' in value;
    
  if (profilePic && isFile(profilePic)) {
    thumbnailPath = "profile-pics/" + profilePic.name;
    await r2.put(thumbnailPath, profilePic);
  }

  const [newUser] = await db
    .insert(schema.users)
    .values({
      name: name.toString(),
      email: email.toString(),
      thumbnail: thumbnailPath || null,
      history: "[]", // Initialize empty history array as JSON string
    })
    .returning();

  return c.json(newUser);
});

app.post("/api/ai", async (c) => {
  const { message } = await c.req.json();
  const messages = [
    { role: "system", content: "You are a friendly assistant" },
    {
      role: "user",
      content: message,
    },
  ];
  const response = await c.env.AI.run(
    "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    { messages }
  );
  return c.json(response);
});

app.get("/openapi.json", (c) => {
  const spec = createOpenAPISpec(app as any, {
    info: { title: "My API", version: "1.0.0" },
  });
  return c.json(spec);
});

app.use(
  "/fp/*",
  createFiberplane({
    openapi: { url: "/openapi.json" },
  })
);

export default instrument(app);
