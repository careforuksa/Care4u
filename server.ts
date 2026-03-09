import express from "express";
import { createServer as createViteServer } from "vite";
import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const db = new Database("caretrack.db");

// Initialize Database (Basic tables first)
db.exec(`
  CREATE TABLE IF NOT EXISTS companies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    contact_person TEXT,
    phone TEXT,
    payment_period TEXT DEFAULT 'monthly', -- 'weekly' or 'monthly'
    last_payment_date DATE,
    next_payment_date DATE
  );

  CREATE TABLE IF NOT EXISTS patients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    company_id INTEGER,
    status TEXT DEFAULT 'active',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (company_id) REFERENCES companies (id)
  );

  CREATE TABLE IF NOT EXISTS services (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE
  );

  CREATE TABLE IF NOT EXISTS packages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    patient_id INTEGER NOT NULL,
    service_id INTEGER NOT NULL,
    total_sessions INTEGER NOT NULL,
    visit_id INTEGER,
    status TEXT DEFAULT 'active',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (patient_id) REFERENCES patients (id),
    FOREIGN KEY (service_id) REFERENCES services (id),
    FOREIGN KEY (visit_id) REFERENCES visits (id)
  );

  CREATE TABLE IF NOT EXISTS session_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    package_id INTEGER NOT NULL,
    session_date DATE NOT NULL,
    notes TEXT,
    FOREIGN KEY (package_id) REFERENCES packages (id)
  );
`);

// Migration: Add next_payment_date to companies if it doesn't exist
const companyTableInfo = db.prepare("PRAGMA table_info(companies)").all() as any[];
const hasNextPaymentDate = companyTableInfo.some(col => col.name === 'next_payment_date');
if (!hasNextPaymentDate) {
  try {
    db.exec("ALTER TABLE companies ADD COLUMN next_payment_date DATE");
    console.log("Migration: Added next_payment_date column to companies table");
  } catch (e) {
    console.error("Migration failed:", e);
  }
}
const hasPaymentPeriod = companyTableInfo.some(col => col.name === 'payment_period');
if (!hasPaymentPeriod) {
  try {
    db.exec("ALTER TABLE companies ADD COLUMN payment_period TEXT DEFAULT 'monthly'");
    db.exec("ALTER TABLE companies ADD COLUMN last_payment_date DATE");
    console.log("Migration: Added payment columns to companies table");
  } catch (e) {
    console.error("Migration failed:", e);
  }
}

db.exec(`
  CREATE TABLE IF NOT EXISTS visits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    patient_id INTEGER,
    service_id INTEGER,
    visit_date DATE NOT NULL,
    amount REAL DEFAULT 0,
    paid_amount REAL DEFAULT 0,
    is_paid INTEGER DEFAULT 0,
    notes TEXT,
    is_postponed INTEGER DEFAULT 0,
    total_sessions INTEGER DEFAULT 1,
    used_sessions INTEGER DEFAULT 0,
    FOREIGN KEY (patient_id) REFERENCES patients (id),
    FOREIGN KEY (service_id) REFERENCES services (id)
  );

  -- Seed default services
  INSERT OR IGNORE INTO services (name) VALUES ('زيارة طبيب'), ('زيارة ممرضة'), ('زيارة علاج طبيعي');
`);

// Migration: Add paid_amount to visits if it doesn't exist
const visitTableInfo = db.prepare("PRAGMA table_info(visits)").all() as any[];
const hasPaidAmount = visitTableInfo.some(col => col.name === 'paid_amount');
if (!hasPaidAmount) {
  try {
    db.exec("ALTER TABLE visits ADD COLUMN paid_amount REAL DEFAULT 0");
    // For existing paid visits, set paid_amount = amount
    db.exec("UPDATE visits SET paid_amount = amount WHERE is_paid = 1");
    console.log("Migration: Added paid_amount column to visits table");
  } catch (e) {
    console.error("Migration failed:", e);
  }
}

const hasIsPostponed = visitTableInfo.some(col => col.name === 'is_postponed');
if (!hasIsPostponed) {
  try {
    db.exec("ALTER TABLE visits ADD COLUMN is_postponed INTEGER DEFAULT 0");
    console.log("Migration: Added is_postponed column to visits table");
  } catch (e) {
    console.error("Migration failed:", e);
  }
}

const hasTotalSessions = visitTableInfo.some(col => col.name === 'total_sessions');
if (!hasTotalSessions) {
  try {
    db.exec("ALTER TABLE visits ADD COLUMN total_sessions INTEGER DEFAULT 1");
    db.exec("ALTER TABLE visits ADD COLUMN used_sessions INTEGER DEFAULT 0");
    console.log("Migration: Added session columns to visits table");
  } catch (e) {
    console.error("Migration failed:", e);
  }
}

const packageTableInfo = db.prepare("PRAGMA table_info(packages)").all() as any[];
const hasVisitId = packageTableInfo.some(col => col.name === 'visit_id');
if (!hasVisitId) {
  try {
    db.exec("ALTER TABLE packages ADD COLUMN visit_id INTEGER");
    console.log("Migration: Added visit_id column to packages table");
  } catch (e) {
    console.error("Migration failed:", e);
  }
}

async function startServer() {
  const app = express();
  app.use(express.json());
  const PORT = 3000;

  // API Routes
  
  // Companies
  app.get("/api/companies", (req, res) => {
    const companies = db.prepare(`
      SELECT c.*, 
      (SELECT COUNT(*) FROM patients WHERE company_id = c.id) as patient_count
      FROM companies c
    `).all();
    res.json(companies);
  });

  app.post("/api/companies", (req, res) => {
    const { name, contact_person, phone, payment_period, next_payment_date } = req.body;
    const info = db.prepare("INSERT INTO companies (name, contact_person, phone, payment_period, next_payment_date) VALUES (?, ?, ?, ?, ?)").run(name, contact_person, phone, payment_period || 'monthly', next_payment_date);
    res.json({ id: info.lastInsertRowid });
  });

  app.put("/api/companies/:id", (req, res) => {
    const { id } = req.params;
    const { name, contact_person, phone, payment_period, last_payment_date, next_payment_date } = req.body;
    db.prepare("UPDATE companies SET name = ?, contact_person = ?, phone = ?, payment_period = ?, last_payment_date = ?, next_payment_date = ? WHERE id = ?")
      .run(name, contact_person, phone, payment_period, last_payment_date, next_payment_date, id);
    res.json({ success: true });
  });

  app.delete("/api/companies/:id", (req, res) => {
    const { id } = req.params;
    // Check if company has patients
    const patients = db.prepare("SELECT COUNT(*) as count FROM patients WHERE company_id = ?").get() as any;
    if (patients.count > 0) {
      return res.status(400).json({ error: "Cannot delete company with existing patients" });
    }
    db.prepare("DELETE FROM companies WHERE id = ?").run(id);
    res.json({ success: true });
  });

  // Packages
  app.get("/api/packages", (req, res) => {
    const { patient_id } = req.query;
    let query = `
      SELECT pk.*, p.name as patient_name, s.name as service_name,
      (SELECT COUNT(*) FROM session_logs WHERE package_id = pk.id) as used_sessions
      FROM packages pk
      JOIN patients p ON pk.patient_id = p.id
      JOIN services s ON pk.service_id = s.id
    `;
    const params = [];
    if (patient_id) {
      query += " WHERE pk.patient_id = ?";
      params.push(patient_id);
    }
    const packages = db.prepare(query).all(...params);
    res.json(packages);
  });

  app.post("/api/packages", (req, res) => {
    const { patient_id, service_id, total_sessions, visit_id } = req.body;
    const info = db.prepare("INSERT INTO packages (patient_id, service_id, total_sessions, visit_id) VALUES (?, ?, ?, ?)").run(patient_id, service_id, total_sessions, visit_id);
    res.json({ id: info.lastInsertRowid });
  });

  app.delete("/api/packages/:id", (req, res) => {
    const { id } = req.params;
    db.prepare("DELETE FROM session_logs WHERE package_id = ?").run(id);
    db.prepare("DELETE FROM packages WHERE id = ?").run(id);
    res.json({ success: true });
  });

  // Session Logs
  app.get("/api/packages/:id/logs", (req, res) => {
    const { id } = req.params;
    const logs = db.prepare("SELECT * FROM session_logs WHERE package_id = ? ORDER BY session_date DESC").all(id);
    res.json(logs);
  });

  app.post("/api/packages/:id/logs", (req, res) => {
    const { id } = req.params;
    const { session_date, notes } = req.body;
    
    const transaction = db.transaction(() => {
      const info = db.prepare("INSERT INTO session_logs (package_id, session_date, notes) VALUES (?, ?, ?)").run(id, session_date, notes);
      
      // Update linked visit if exists
      const pkg = db.prepare("SELECT visit_id, total_sessions FROM packages WHERE id = ?").get() as any;
      if (pkg && pkg.visit_id) {
        const usedCount = db.prepare("SELECT COUNT(*) as count FROM session_logs WHERE package_id = ?").get() as any;
        const isPaid = usedCount.count >= pkg.total_sessions ? 1 : 0;
        db.prepare("UPDATE visits SET used_sessions = ?, is_paid = CASE WHEN ? = 1 THEN 1 ELSE is_paid END WHERE id = ?")
          .run(usedCount.count, isPaid, pkg.visit_id);
      }
      
      return info.lastInsertRowid;
    });

    const lastId = transaction();
    res.json({ id: lastId });
  });

  app.delete("/api/logs/:id", (req, res) => {
    const { id } = req.params;
    db.prepare("DELETE FROM session_logs WHERE id = ?").run(id);
    res.json({ success: true });
  });

  // Patients
  app.get("/api/patients", (req, res) => {
    const patients = db.prepare(`
      SELECT p.*, c.name as company_name 
      FROM patients p 
      LEFT JOIN companies c ON p.company_id = c.id
      ORDER BY p.created_at DESC
    `).all();
    res.json(patients);
  });

  app.post("/api/patients", (req, res) => {
    const { name, company_id } = req.body;
    const info = db.prepare("INSERT INTO patients (name, company_id) VALUES (?, ?)").run(name, company_id);
    res.json({ id: info.lastInsertRowid });
  });

  app.put("/api/patients/:id", (req, res) => {
    const { id } = req.params;
    const { name, company_id, status } = req.body;
    db.prepare("UPDATE patients SET name = ?, company_id = ?, status = ? WHERE id = ?").run(name, company_id, status, id);
    res.json({ success: true });
  });

  app.delete("/api/patients/:id", (req, res) => {
    const { id } = req.params;
    // Check if patient has visits
    const visits = db.prepare("SELECT COUNT(*) as count FROM visits WHERE patient_id = ?").get() as any;
    if (visits.count > 0) {
      return res.status(400).json({ error: "Cannot delete patient with existing visits" });
    }
    db.prepare("DELETE FROM patients WHERE id = ?").run(id);
    res.json({ success: true });
  });

  // Visits
  app.get("/api/visits", (req, res) => {
    const { month, year, start_date, end_date, company_id } = req.query;
    let query = `
      SELECT v.*, p.name as patient_name, c.name as company_name, s.name as service_name
      FROM visits v
      JOIN patients p ON v.patient_id = p.id
      LEFT JOIN companies c ON p.company_id = c.id
      LEFT JOIN services s ON v.service_id = s.id
      WHERE 1=1
    `;
    const params = [];
    if (month && year) {
      query += " AND strftime('%m', v.visit_date) = ? AND strftime('%Y', v.visit_date) = ?";
      params.push(month.toString().padStart(2, '0'), year.toString());
    }
    if (start_date && end_date) {
      query += " AND v.visit_date BETWEEN ? AND ?";
      params.push(start_date, end_date);
    }
    if (company_id) {
      query += " AND p.company_id = ?";
      params.push(company_id);
    }
    query += " ORDER BY v.visit_date DESC";
    const visits = db.prepare(query).all(...params);
    res.json(visits);
  });

  app.post("/api/visits", (req, res) => {
    const { patient_id, service_id, visit_date, amount, notes, paid_amount, total_sessions } = req.body;
    const is_paid = (paid_amount || 0) >= (amount || 0) ? 1 : 0;
    
    const transaction = db.transaction(() => {
      const info = db.prepare("INSERT INTO visits (patient_id, service_id, visit_date, amount, paid_amount, is_paid, notes, total_sessions) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(patient_id, service_id, visit_date, amount, paid_amount || 0, is_paid, notes, total_sessions || 1);
      
      const visitId = info.lastInsertRowid;

      if (total_sessions && total_sessions > 1) {
        db.prepare("INSERT INTO packages (patient_id, service_id, total_sessions, visit_id) VALUES (?, ?, ?, ?)")
          .run(patient_id, service_id, total_sessions, visitId);
      }

      return visitId;
    });

    const visitId = transaction();
    res.json({ id: visitId });
  });

  app.put("/api/visits/:id", (req, res) => {
    const { id } = req.params;
    const { patient_id, service_id, visit_date, amount, paid_amount, notes, is_paid } = req.body;
    const final_is_paid = is_paid !== undefined ? (is_paid ? 1 : 0) : ((paid_amount || 0) >= (amount || 0) ? 1 : 0);
    db.prepare("UPDATE visits SET patient_id = ?, service_id = ?, visit_date = ?, amount = ?, paid_amount = ?, notes = ?, is_paid = ? WHERE id = ?")
      .run(patient_id, service_id, visit_date, amount, paid_amount || 0, notes, final_is_paid, id);
    res.json({ success: true });
  });

  app.patch("/api/visits/:id/pay", (req, res) => {
    const { id } = req.params;
    const { is_paid, paid_amount } = req.body;
    if (paid_amount !== undefined) {
      const visit = db.prepare("SELECT amount FROM visits WHERE id = ?").get() as any;
      const final_is_paid = paid_amount >= visit.amount ? 1 : 0;
      db.prepare("UPDATE visits SET paid_amount = ?, is_paid = ? WHERE id = ?").run(paid_amount, final_is_paid, id);
    } else if (is_paid !== undefined) {
      const visit = db.prepare("SELECT amount FROM visits WHERE id = ?").get() as any;
      const new_paid_amount = is_paid ? visit.amount : 0;
      db.prepare("UPDATE visits SET is_paid = ?, paid_amount = ? WHERE id = ?").run(is_paid ? 1 : 0, new_paid_amount, id);
    }
    res.json({ success: true });
  });

  app.post("/api/companies/:id/payments", (req, res) => {
    const { id } = req.params;
    const { amount, date } = req.body;
    
    // 1. Update company last_payment_date
    db.prepare("UPDATE companies SET last_payment_date = ? WHERE id = ?").run(date, id);
    
    // 2. Get unpaid visits for this company
    const unpaidVisits = db.prepare(`
      SELECT v.* FROM visits v
      JOIN patients p ON v.patient_id = p.id
      WHERE p.company_id = ? AND v.is_paid = 0
      ORDER BY v.visit_date ASC
    `).all(id) as any[];
    
    let remaining = amount;
    for (const visit of unpaidVisits) {
      if (remaining <= 0) break;
      
      const visitRemaining = visit.amount - (visit.paid_amount || 0);
      const paymentForThisVisit = Math.min(remaining, visitRemaining);
      
      const newPaidAmount = (visit.paid_amount || 0) + paymentForThisVisit;
      const isPaid = newPaidAmount >= visit.amount ? 1 : 0;
      
      db.prepare("UPDATE visits SET paid_amount = ?, is_paid = ? WHERE id = ?")
        .run(newPaidAmount, isPaid, visit.id);
      
      remaining -= paymentForThisVisit;
    }
    
    res.json({ success: true, remaining });
  });

  // Services
  app.get("/api/services", (req, res) => {
    const services = db.prepare("SELECT * FROM services").all();
    res.json(services);
  });

  app.post("/api/services", (req, res) => {
    const { name } = req.body;
    try {
      const info = db.prepare("INSERT INTO services (name) VALUES (?)").run(name);
      res.json({ id: info.lastInsertRowid });
    } catch (e) {
      res.status(400).json({ error: "Service already exists" });
    }
  });

  app.delete("/api/services/:id", (req, res) => {
    const { id } = req.params;
    db.prepare("DELETE FROM services WHERE id = ?").run(id);
    res.json({ success: true });
  });

  // Company Statistics by Date
  app.get("/api/stats/companies", (req, res) => {
    const { start_date, end_date, company_id } = req.query;
    if (!start_date || !end_date) {
      return res.status(400).json({ error: "start_date and end_date are required" });
    }

    let query = `
      SELECT 
        c.name as company_name,
        COUNT(DISTINCT p.id) as patient_count,
        COUNT(v.id) as visit_count,
        SUM(v.amount) as total_amount
      FROM companies c
      LEFT JOIN patients p ON p.company_id = c.id
      LEFT JOIN visits v ON v.patient_id = p.id AND v.visit_date BETWEEN ? AND ?
      WHERE 1=1
    `;
    const params = [start_date, end_date];

    if (company_id) {
      query += " AND c.id = ?";
      params.push(company_id);
    }

    query += " GROUP BY c.id";
    
    const stats = db.prepare(query).all(...params);
    res.json(stats);
  });

  // Summary Stats
  app.get("/api/stats", (req, res) => {
    const stats = db.prepare(`
      SELECT 
        (SELECT COUNT(*) FROM patients) as total_patients,
        (SELECT SUM(amount - paid_amount) FROM visits WHERE is_paid = 0) as pending_amount,
        (SELECT SUM(amount - paid_amount) FROM visits v JOIN patients p ON v.patient_id = p.id WHERE v.is_paid = 0 AND p.company_id IS NOT NULL) as company_pending,
        (SELECT SUM(amount - paid_amount) FROM visits v JOIN patients p ON v.patient_id = p.id WHERE v.is_paid = 0 AND p.company_id IS NULL) as direct_pending,
        (SELECT SUM(paid_amount) FROM visits) as paid_amount
      FROM visits LIMIT 1
    `).get() || { total_patients: 0, pending_amount: 0, paid_amount: 0, company_pending: 0, direct_pending: 0 };
    res.json(stats);
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(__dirname, "dist")));
    app.get("*", (req, res) => {
      res.sendFile(path.join(__dirname, "dist", "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
