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

/**
 * Ajoute un texte et un fichier PDF à l'historique d'un utilisateur
 * @param env - L'environnement Cloudflare Workers contenant DB et BUCKET
 * @param userId - L'ID de l'utilisateur
 * @param answer - Le texte à ajouter à l'historique
 * @param pdfFile - Le fichier PDF à ajouter (optionnel)
 * @returns L'utilisateur mis à jour
 */
export async function addToUserHistory(
  env: Bindings,
  userId: number,
  answer: string,
  pdfFile?: File | null
) {
  const db = drizzle(env.DB);
  const r2 = env.BUCKET;

  const users = await db.select().from(schema.users);
  const user = users.find(u => u.id === userId);

  if (!user) {
    throw new Error(`User with ID ${userId} not found`);
  }

  let history = [];
  try {
    history = JSON.parse(user.history);
  } catch (e) {
    history = []; 
  }

  const newEntry: { 
    timestamp: string; 
    answer: string; 
    pdfPath?: string;
    pdfName?: string;
  } = {
    timestamp: new Date().toISOString(),
    answer: answer,
  };

  if (pdfFile) {
    const originalFileName = pdfFile.name;
    const pdfPath = `user-pdfs/${userId}/${Date.now()}-${originalFileName}`;
    await r2.put(pdfPath, pdfFile);
    newEntry.pdfPath = pdfPath;
    newEntry.pdfName = originalFileName; 
  }

  history.push(newEntry);

  const newHistoryJson = JSON.stringify(history);
  
  const allUsers = await db.select().from(schema.users);
  const usersToUpdate = allUsers.filter(u => u.id !== userId);
  
  user.history = newHistoryJson;
  
  await db.delete(schema.users);
  await db.insert(schema.users).values([...usersToUpdate, user]);
  
  const updatedUsers = await db.select().from(schema.users);
  const updatedUser = updatedUsers.find(u => u.id === userId);

  if (!updatedUser) {
    throw new Error(`Failed to retrieve updated user with ID ${userId}`);
  }

  return updatedUser;
}

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

// Endpoint pour ajouter un PDF à l'historique d'un utilisateur
app.post("/api/user/:id/upload-pdf", async (c) => {
  const userId = parseInt(c.req.param("id"));
  const formData = await c.req.formData();
  const pdfFile = formData.get("pdf-file");
  const pdfContent = formData.get("pdf-content");
  
  const isFile = (value: unknown): value is { name: string; stream: () => ReadableStream } => 
    value !== null && 
    typeof value === 'object' && 
    'name' in value &&
    'stream' in value;
  
  if (!pdfFile || !isFile(pdfFile)) {
    return c.json({ error: "PDF file is required" }, 400);
  }
  
  // Générer une évaluation du contenu PDF en utilisant l'IA
  let answer = "PDF document uploaded successfully";
  
  if (pdfContent && typeof pdfContent === 'string') {
    try {
      // Préparer le message pour l'IA
      const content = pdfContent;
      const messages = [
        {
          role: "system",
          content: "You are an expert evaluator. Analyze the student's exam submission, provide a score out of 10, identify weak topics, and recommend the top 5 resources (videos or articles) to help improve their skills."
        },
        { role: "user", content: content }
      ];
      
      // Appeler l'IA pour analyser le contenu
      const aiResponse = await c.env.AI.run(
        "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
        { messages }
      );
      
      // Utiliser la réponse de l'IA
      if (typeof aiResponse === 'object' && aiResponse !== null) {
        // Essayer d'extraire la réponse en fonction du format (peut varier selon l'API)
        if ('response' in aiResponse) {
          answer = aiResponse.response as string;
        } else if ('text' in aiResponse) {
          answer = aiResponse.text as string;
        } else if ('choices' in aiResponse && Array.isArray(aiResponse.choices) && aiResponse.choices.length > 0) {
          answer = aiResponse.choices[0].text || aiResponse.choices[0].message?.content || JSON.stringify(aiResponse);
        } else {
          // Fallback: convertir toute la réponse en chaîne
          answer = JSON.stringify(aiResponse);
        }
      } else {
        answer = String(aiResponse);
      }
      
      // Si la réponse est trop longue, limiter sa taille
      if (answer.length > 1000) {
        answer = answer.substring(0, 997) + "...";
      }
    } catch (error) {
      console.error("Erreur lors de l'analyse IA du PDF:", error);
      // Utiliser un résumé du contenu du PDF en cas d'erreur
      const contentSummary = pdfContent.substring(0, 150).trim();
      answer = contentSummary.length > 0 
        ? `PDF Content: ${contentSummary}${pdfContent.length > 150 ? '...' : ''}` 
        : "PDF uploaded (no text content extracted)";
    }
  }
  
  try {
    const updatedUser = await addToUserHistory(c.env, userId, answer, pdfFile as unknown as File);
    return c.json(updatedUser);
  } catch (error: any) {
    console.error("Erreur lors de l'ajout du PDF à l'historique:", error);
    return c.json({ error: error.message || "Unknown error" }, 500);
  }
});

// Endpoint pour récupérer un fichier PDF stocké
app.get("/api/pdf/:path+", async (c) => {
  const filePath = c.req.param("path");
  
  console.log("Attempting to fetch PDF, path parameter:", filePath);
  
  if (!filePath) {
    return c.json({ error: "File path is required" }, 400);
  }
  
  try {
    // Récupérer le fichier du bucket R2
    const file = await c.env.BUCKET.get(filePath);
    
    if (!file) {
      console.log("PDF file not found in R2 bucket:", filePath);
      return c.json({ error: "File not found" }, 404);
    }
    
    console.log("PDF file found, returning response");
    
    // Définir les headers pour un fichier PDF
    const headers = new Headers();
    headers.set("Content-Type", "application/pdf");
    headers.set("Content-Disposition", `inline; filename="${filePath.split('/').pop() || 'document.pdf'}"`);
    
    // Récupérer le corps du fichier
    const body = await file.arrayBuffer();
    
    // Retourner le fichier
    return new Response(body, {
      headers: headers,
    });
  } catch (error: any) {
    console.error("Erreur lors de la récupération du PDF:", error);
    return c.json({ error: error.message || "Unknown error" }, 500);
  }
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
