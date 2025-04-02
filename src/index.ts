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
  const profile = formData.get("profile-pic") as File;

  if (!name || !email) {
    return c.json({ error: "Name and email are required" }, 400);
  }
  await r2.put("profile-pics/" + profile.name, profile);
  const [newUser] = await db
    .insert(schema.users)
    .values({
      name: name,
      email: email,
      thumbnail: "profile-pics/" + profile.name,
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
  const spec = createOpenAPISpec(app, {
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
