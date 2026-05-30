import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";
import { initializeApp } from "firebase/app";
import { initializeFirestore, collection, addDoc, getDoc, getDocs, query, where, doc, deleteDoc, updateDoc, writeBatch, orderBy, limit } from "firebase/firestore";
import dotenv from "dotenv";
import fs from "fs";
import nodemailer from "nodemailer";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load Firebase Config
const firebaseConfig = JSON.parse(fs.readFileSync(path.join(__dirname, "firebase-applet-config.json"), "utf8"));

const app = initializeApp(firebaseConfig);
const db = initializeFirestore(app, {
  experimentalForceLongPolling: true,
  experimentalAutoDetectLongPolling: false,
  useFetchStreams: false,
} as any, firebaseConfig.firestoreDatabaseId);

async function startServer() {
  const server = express();
  const PORT = 3000;

  server.use(express.json());

  // API Route for Settings
  server.get("/api/settings", async (req, res) => {
    try {
      const settingsSnap = await getDocs(collection(db, "app_settings"));
      if (settingsSnap.empty) {
        return res.status(200).json({ autoAssignEnabled: false, lastAssignedAgentIndex: 0 });
      }
      res.status(200).json(settingsSnap.docs[0].data());
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch settings" });
    }
  });

  server.put("/api/settings", async (req, res) => {
    const { autoAssignEnabled } = req.body;
    try {
      const settingsSnap = await getDocs(collection(db, "app_settings"));
      if (settingsSnap.empty) {
        await addDoc(collection(db, "app_settings"), { autoAssignEnabled, lastAssignedAgentIndex: 0 });
      } else {
        const settingsRef = doc(db, "app_settings", settingsSnap.docs[0].id);
        await updateDoc(settingsRef, { autoAssignEnabled });
      }
      res.status(200).json({ message: "Settings updated" });
    } catch (error) {
      res.status(500).json({ error: "Failed to update settings" });
    }
  });

  // Helper for Round Robin Assignment
  const getNextAgentForAssignment = async () => {
    const settingsSnap = await getDocs(collection(db, "app_settings"));
    const settingsData = settingsSnap.empty ? { autoAssignEnabled: false, lastAssignedAgentIndex: 0 } : settingsSnap.docs[0].data();
    
    if (!settingsData.autoAssignEnabled) return null;

    const agentsSnap = await getDocs(query(collection(db, "agents"), where("active", "==", true)));
    if (agentsSnap.empty) return null;

    const agents = agentsSnap.docs.map(d => ({ id: d.id, ...d.data() } as any));
    const nextIndex = (settingsData.lastAssignedAgentIndex + 1) % agents.length;
    const assignedAgent = agents[nextIndex];

    // Update the index for next time
    if (!settingsSnap.empty) {
      const settingsRef = doc(db, "app_settings", settingsSnap.docs[0].id);
      await updateDoc(settingsRef, { lastAssignedAgentIndex: nextIndex });
    }

    return assignedAgent;
  };

  // API Route to Fetch Leads with Optional Filtering
  server.get("/api/leads", async (req, res) => {
    const { assigned_to } = req.query;
    try {
      const leadsRef = collection(db, "leads");
      let q;
      if (assigned_to) {
        q = query(leadsRef, where("assignedTo", "==", assigned_to));
      } else {
        q = query(leadsRef, orderBy("createdAt", "desc"), limit(100));
      }
      const snap = await getDocs(q);
      const leads = snap.docs.map(d => ({ id: d.id, ...d.data() as object }));
      res.status(200).json(leads);
    } catch (error) {
      console.error("Error fetching leads:", error);
      res.status(500).json({ error: "Failed to fetch leads" });
    }
  });

  // API Route for External Lead Intake
  server.post("/api/leads", async (req, res) => {
    const apiKey = req.headers["x-api-key"];
    const expectedKey = process.env.CRM_API_KEY;

    if (!expectedKey || apiKey !== expectedKey) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { name, phone, email, source, productInterest, product } = req.body;
    const finalProduct = productInterest || product || "General Inquiry";

    if (!name || !phone) {
      return res.status(400).json({ error: "Name and Phone are required" });
    }

    try {
      const leadsRef = collection(db, "leads");
      // Check for existing records with same phone or email
      let q = query(leadsRef, where("phone", "==", phone));
      let snap = await getDocs(q);
      
      if (snap.empty && email) {
        q = query(leadsRef, where("email", "==", email));
        snap = await getDocs(q);
      }

      let customerId = "";
      if (!snap.empty) {
        // Customer exists
        const existingLeads = snap.docs.map(doc => doc.data());
        customerId = existingLeads[0].customerId || snap.docs[0].id; // Fallback to first lead ID if customerId missing

        // Check if same product already exists for this customer
        const sameProductLead = existingLeads.find(l => l.productInterest === finalProduct);
        if (sameProductLead) {
          return res.status(409).json({ 
            error: "Customer already exists for this product",
            existingLead: {
              status: sameProductLead.status,
              createdAt: sameProductLead.createdAt,
              product: sameProductLead.productInterest
            }
          });
        }
      } else {
        // New customer, generate a unique ID
        const customerRef = doc(collection(db, "customers"));
        customerId = customerRef.id;
      }

      // Perform Round Robin if enabled
      const assignedAgent = await getNextAgentForAssignment();

      await addDoc(collection(db, "leads"), {
        name,
        phone,
        email: email || "",
        customerId,
        productInterest: finalProduct,
        status: "New",
        source: source || "External API",
        assignedTo: assignedAgent ? assignedAgent.email : null,
        assignedToName: assignedAgent ? assignedAgent.name : null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        remarks: [{ 
          text: assignedAgent ? `Lead received via API and auto-assigned to ${assignedAgent.name}` : "Lead received via API", 
          timestamp: new Date().toISOString(),
          agent: "System"
        }],
        isHot: false
      });
      res.status(201).json({ message: "Lead added successfully", customerId });
    } catch (error) {
      console.error("Error adding lead:", error);
      res.status(500).json({ error: "Internal Server Error" });
    }
  });

  // Helper: write an audit log entry. Failures are swallowed so they never
  // block the primary destructive action that the operator just confirmed.
  const writeAuditLog = async (entry: {
    action: string;
    details: string;
    userId?: string;
    userName?: string;
    leadId?: string;
  }) => {
    try {
      await addDoc(collection(db, "logs"), {
        userId: entry.userId || "system",
        userName: entry.userName || "System",
        action: entry.action,
        details: entry.details,
        leadId: entry.leadId || "",
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      console.error("Failed to write audit log:", err);
    }
  };

  // Commit a batch in chunks. Firestore caps each batch at 500 writes.
  const commitInChunks = async (
    refs: Array<{ type: "delete" | "update"; ref: any; data?: any }>
  ) => {
    const CHUNK = 450;
    for (let i = 0; i < refs.length; i += CHUNK) {
      const slice = refs.slice(i, i + CHUNK);
      const batch = writeBatch(db);
      slice.forEach(op => {
        if (op.type === "delete") batch.delete(op.ref);
        else batch.update(op.ref, op.data);
      });
      await batch.commit();
    }
  };

  // API Route for Agent Deletion
  //
  // Default behaviour: delete the agent document and unassign their leads
  // (leads are preserved so they can be reassigned).
  //
  // ?permanent=true : delete the agent document AND every lead assigned to
  // them. This is a destructive, non-reversible "hard delete" intended for
  // admin clean-up of test data or off-boarded agents whose pipeline should
  // also be purged. The caller may pass `actorId` / `actorName` in the body
  // (or `x-actor-*` headers) so the audit log records who performed the
  // action.
  server.delete("/api/agents/:agentId", async (req, res) => {
    const { agentId } = req.params;
    const permanent =
      req.query.permanent === "true" || req.query.permanent === "1";
    const actorId =
      (req.body && req.body.actorId) ||
      (req.headers["x-actor-id"] as string) ||
      "system";
    const actorName =
      (req.body && req.body.actorName) ||
      (req.headers["x-actor-name"] as string) ||
      "System";

    if (!agentId) return res.status(400).json({ error: "Agent ID required" });

    try {
      // Fetch the agent by direct doc reference. The previous implementation
      // used `where("__name__", "==", agentId)` which silently returned an
      // empty snapshot in the Firestore Web SDK (the special __name__ field
      // is a DocumentReference, not a string), so the entire unassign step
      // was being skipped and only the agent doc was deleted.
      const agentRef = doc(db, "agents", agentId);
      const agentDoc = await getDoc(agentRef);

      if (!agentDoc.exists()) {
        return res.status(404).json({ error: "Agent not found" });
      }

      const agentData = agentDoc.data() as any;
      const agentEmail: string | undefined = agentData.email;
      const agentName: string =
        agentData.name || agentEmail || agentId;

      // Leads can be linked to an agent by email (current convention) or, in
      // legacy / inconsistent data, by the agent's doc id. Gather both so the
      // unassign / cascade-delete is exhaustive.
      const leadsRef = collection(db, "leads");
      const lookupKeys = Array.from(
        new Set(
          [agentEmail, agentId].filter(
            (v): v is string => typeof v === "string" && v.length > 0
          )
        )
      );

      const seen = new Set<string>();
      const matchedLeads: Array<{ id: string; ref: any }> = [];

      for (const key of lookupKeys) {
        const snap = await getDocs(
          query(leadsRef, where("assignedTo", "==", key))
        );
        snap.docs.forEach(d => {
          if (!seen.has(d.id)) {
            seen.add(d.id);
            matchedLeads.push({ id: d.id, ref: d.ref });
          }
        });
      }

      console.log(
        `[agent-delete] agentId=${agentId} email=${agentEmail} permanent=${permanent} matchedLeads=${matchedLeads.length}`
      );

      let affectedLeads = 0;

      if (matchedLeads.length > 0) {
        if (permanent) {
          const ops = matchedLeads.map(l => ({
            type: "delete" as const,
            ref: l.ref,
          }));
          await commitInChunks(ops);
          affectedLeads = ops.length;
        } else {
          const ops = matchedLeads.map(l => ({
            type: "update" as const,
            ref: l.ref,
            data: {
              assignedTo: null,
              assignedToName: null,
              updatedAt: new Date().toISOString(),
            },
          }));
          await commitInChunks(ops);
          affectedLeads = ops.length;
        }
      }

      await deleteDoc(agentRef);

      await writeAuditLog({
        action: permanent ? "AGENT_PERMANENT_DELETE" : "AGENT_DELETE",
        details: permanent
          ? `Permanently removed agent ${agentName} (${agentEmail}) and ${affectedLeads} associated lead(s).`
          : `Removed agent ${agentName} (${agentEmail}); ${affectedLeads} lead(s) unassigned.`,
        userId: actorId,
        userName: actorName,
      });

      res.status(200).json({
        message: permanent
          ? "Agent and all associated leads permanently deleted"
          : "Agent deleted and leads unassigned",
        permanent,
        deletedAgentId: agentId,
        leadsAffected: affectedLeads,
      });
    } catch (error) {
      console.error("Error deleting agent:", error);
      res.status(500).json({ error: "Failed to delete agent" });
    }
  });

  // API Route to Unassign Lead
  server.put("/api/leads/:leadId/unassign", async (req, res) => {
    const { leadId } = req.params;
    if (!leadId) return res.status(400).json({ error: "Lead ID required" });

    try {
      const leadRef = doc(db, "leads", leadId);
      await updateDoc(leadRef, {
        assignedTo: null,
        assignedToName: null,
        updatedAt: new Date().toISOString()
      });
      res.status(200).json({ message: "Lead unassigned successfully" });
    } catch (error) {
      console.error("Error unassigning lead:", error);
      res.status(500).json({ error: "Failed to unassign lead" });
    }
  });

  // API Route to Update Lead
  server.put("/api/leads/:leadId", async (req, res) => {
    const { leadId } = req.params;
    const updateData = req.body;
    
    if (!leadId) return res.status(400).json({ error: "Lead ID required" });

    try {
      const leadRef = doc(db, "leads", leadId);
      await updateDoc(leadRef, {
        ...updateData,
        updatedAt: new Date().toISOString()
      });
      res.status(200).json({ message: "Lead updated successfully" });
    } catch (error) {
      console.error("Error updating lead:", error);
      res.status(500).json({ error: "Failed to update lead" });
    }
  });

  // API Route for Single Lead Assignment
  server.put("/api/leads/:leadId/assign", async (req, res) => {
    const { leadId } = req.params;
    const { agentEmail, agentName, agentId } = req.body;

    const isUnassign = agentId === null || agentEmail === null || agentEmail === "unassign";

    if (!leadId) return res.status(400).json({ error: "Missing leadId" });
    if (!isUnassign && !agentEmail) return res.status(400).json({ error: "Missing agentEmail" });

    try {
      const leadRef = doc(db, "leads", leadId);
      await updateDoc(leadRef, {
        assignedTo: isUnassign ? null : agentEmail,
        assignedToName: isUnassign ? null : agentName,
        updatedAt: new Date().toISOString(),
        remarks: [{
          text: isUnassign ? "Lead unassigned by Admin" : `Lead assigned to ${agentName} by Admin`,
          timestamp: new Date().toISOString(),
          agent: "System (Admin)"
        }]
      });
      res.status(200).json({ message: `Lead ${isUnassign ? 'unassigned' : 'assigned'} successfully` });
    } catch (error) {
      console.error("Error assigning lead:", error);
      res.status(500).json({ error: "Failed to assign lead" });
    }
  });

  // API Route for Bulk Lead Assignment
  server.post("/api/leads/assign", async (req, res) => {
    const { leadIds, agentEmail, agentName, agentId } = req.body;
    
    // Explicit Unassign Detection
    const isUnassign = 
      agentId === null || 
      agentEmail === null || 
      agentEmail === "unassign" || 
      (!agentEmail && !agentId);

    console.log("---- BULK ASSIGNMENT START ----");
    console.log("Payload:", { leadIdsCount: leadIds?.length, agentEmail, agentName, agentId });
    console.log("Detected Action:", isUnassign ? "UNASSIGN" : "ASSIGN");

    if (!leadIds || !Array.isArray(leadIds) || leadIds.length === 0) {
      console.error("Validation Error: Missing leadIds");
      return res.status(400).json({ error: "Missing leadIds" });
    }

    try {
      const batch = writeBatch(db);
      const timestamp = new Date().toISOString();

      leadIds.forEach(id => {
        const leadRef = doc(db, "leads", id);
        batch.update(leadRef, {
          assignedTo: isUnassign ? null : agentEmail,
          assignedToName: isUnassign ? null : agentName,
          updatedAt: timestamp,
        });
      });

      await batch.commit();
      console.log(`Firestore successfully updated ${leadIds.length} leads to ${isUnassign ? 'NULL' : agentEmail}`);
      console.log("---- BULK ASSIGNMENT END ----");

      res.status(200).json({ 
        message: `Successfully ${isUnassign ? 'unassigned' : 'assigned'} ${leadIds.length} leads`,
        count: leadIds.length,
        action: isUnassign ? "unassign" : "assign"
      });
    } catch (error) {
      console.error("Error in bulk assignment:", error);
      res.status(500).json({ error: "Failed to bulk assign leads" });
    }
  });

  // API Route to fetch Customer and all related Leads
  server.get("/api/customers/:customerId", async (req, res) => {
    const { customerId } = req.params;
    if (!customerId) return res.status(400).json({ error: "Customer ID required" });

    try {
      const leadsRef = collection(db, "leads");
      const q = query(leadsRef, where("customerId", "==", customerId));
      const snap = await getDocs(q);
      
      const leads = snap.docs.map(doc => ({ id: doc.id, ...doc.data() } as any));
      
      if (leads.length === 0) {
        return res.status(404).json({ error: "Customer not found" });
      }

      // Deriving customer info from the first lead found (or we could have a customers collection)
      // Since leads are linked by customerId, we'll return the primary info from the most recent one
      const sortedLeads = leads.sort((a: any, b: any) => 
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );

      const customerInfo = {
        customerId,
        name: sortedLeads[0].name,
        phone: sortedLeads[0].phone,
        email: sortedLeads[0].email,
        city: sortedLeads[0].city,
        leads: sortedLeads
      };

      res.status(200).json(customerInfo);
    } catch (error) {
      console.error("Error fetching customer profile:", error);
      res.status(500).json({ error: "Failed to fetch customer profile" });
    }
  });

  // API Route for Customer Deletion
  //
  // Customers in this CRM are mostly virtual: they are identified by the
  // `customerId` field stamped onto each lead at intake. A customer doc may
  // also exist in the `customers` collection.
  //
  // ?permanent=true : hard-delete every lead with this customerId AND the
  // customer document (if present). Without `permanent=true` the endpoint
  // refuses to act, because there is no meaningful "soft delete" for a
  // customer that is purely derived from their leads — the caller must
  // explicitly opt in to the destructive operation.
  server.delete("/api/customers/:customerId", async (req, res) => {
    const { customerId } = req.params;
    const permanent =
      req.query.permanent === "true" || req.query.permanent === "1";
    const actorId =
      (req.body && req.body.actorId) ||
      (req.headers["x-actor-id"] as string) ||
      "system";
    const actorName =
      (req.body && req.body.actorName) ||
      (req.headers["x-actor-name"] as string) ||
      "System";

    if (!customerId) {
      return res.status(400).json({ error: "Customer ID required" });
    }

    if (!permanent) {
      return res.status(400).json({
        error:
          "Customer deletion is destructive. Pass ?permanent=true to confirm.",
      });
    }

    try {
      const leadsRef = collection(db, "leads");
      const q = query(leadsRef, where("customerId", "==", customerId));
      const leadSnap = await getDocs(q);

      let customerLabel = customerId;
      let deletedLeads = 0;

      if (!leadSnap.empty) {
        const first = leadSnap.docs[0].data() as any;
        customerLabel = first.name
          ? `${first.name} (${customerId})`
          : customerId;

        const ops = leadSnap.docs.map(d => ({
          type: "delete" as const,
          ref: d.ref,
        }));
        await commitInChunks(ops);
        deletedLeads = ops.length;
      }

      // Also remove the customer doc itself if one exists. Wrapped so a
      // missing customers/{id} document doesn't fail the whole request.
      let customerDocDeleted = false;
      try {
        await deleteDoc(doc(db, "customers", customerId));
        customerDocDeleted = true;
      } catch (err) {
        console.warn(
          `No standalone customer doc to delete for ${customerId} (this is fine):`,
          err
        );
      }

      if (deletedLeads === 0 && !customerDocDeleted) {
        return res.status(404).json({ error: "Customer not found" });
      }

      await writeAuditLog({
        action: "CUSTOMER_PERMANENT_DELETE",
        details: `Permanently removed customer ${customerLabel} and ${deletedLeads} associated lead(s).`,
        userId: actorId,
        userName: actorName,
      });

      res.status(200).json({
        message: "Customer and all associated leads permanently deleted",
        permanent: true,
        deletedCustomerId: customerId,
        leadsDeleted: deletedLeads,
        customerDocDeleted,
      });
    } catch (error) {
      console.error("Error deleting customer:", error);
      res.status(500).json({ error: "Failed to delete customer" });
    }
  });

  // API Route for Assignment Email
  server.post("/api/notify-assignment", async (req, res) => {
    const { agentEmail, agentName, leadName, leadPhone, appUrl } = req.body;

    if (!agentEmail || !agentName || !leadName || !leadPhone) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    try {
      let transporter;
      
      if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
        transporter = nodemailer.createTransport({
          host: process.env.SMTP_HOST,
          port: parseInt(process.env.SMTP_PORT || "587"),
          secure: process.env.SMTP_PORT === "465",
          auth: {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS,
          },
        });
      } else {
        // Fallback for development/demo
        console.log("-----------------------------------------");
        console.log("MOCK EMAIL NOTIFICATION SENT");
        console.log(`TO: ${agentEmail} (${agentName})`);
        console.log(`SUBJECT: New Lead Assigned: ${leadName}`);
        console.log(`BODY: You have been assigned a new lead. Name: ${leadName}, Phone: ${leadPhone}. View details at: ${appUrl}`);
        console.log("-----------------------------------------");
        return res.status(200).json({ message: "Mock email logged (SMTP not configured)" });
      }

      await transporter.sendMail({
        from: process.env.FROM_EMAIL || '"TFA Team CRM" <notifications@tfa.in>',
        to: agentEmail,
        subject: `New Lead Assigned: ${leadName}`,
        html: `
          <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e2e8f0; rounded: 8px;">
            <h2 style="color: #4f46e5;">New Lead Assigned</h2>
            <p>Hello <strong>${agentName}</strong>,</p>
            <p>You have been assigned a new lead in the TFA Team CRM.</p>
            <div style="background-color: #f8fafc; padding: 15px; border-radius: 8px; margin: 20px 0;">
              <p style="margin: 5px 0;"><strong>Name:</strong> ${leadName}</p>
              <p style="margin: 5px 0;"><strong>Contact:</strong> ${leadPhone}</p>
            </div>
            <p>Please click the link below to view details and start working on this lead:</p>
            <a href="${appUrl}" style="display: inline-block; background-color: #4f46e5; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold;">Open CRM Dashboard</a>
            <p style="margin-top: 30px; font-size: 12px; color: #64748b;">This is an automated notification from the TFA Team CRM.</p>
          </div>
        `,
      });

      res.status(200).json({ message: "Email notification sent" });
    } catch (error) {
      console.error("Error sending notification:", error);
      res.status(500).json({ error: "Failed to send notification" });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    server.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    server.use(express.static(distPath));
    server.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
