import {
  pgSchema,
  uuid,
  text,
  boolean,
  timestamp,
  integer,
  doublePrecision,
  jsonb,
  customType,
  index,
  serial,
} from "drizzle-orm/pg-core";

/** All tables live in a dedicated "bom" schema owned by the app's DB role. */
export const bom = pgSchema("bom");

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

export const roleEnum = bom.enum("role", ["ADMIN", "USER"]);

export const users = bom.table("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  name: text("name"),
  passwordHash: text("password_hash").notNull(),
  role: roleEnum("role").notNull().default("USER"),
  active: boolean("active").notNull().default(true),
  mustChangePassword: boolean("must_change_password").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
});

/** Single-row settings table (id = 1). */
export const settings = bom.table("settings", {
  id: integer("id").primaryKey().default(1),
  apiKeyCiphertext: text("api_key_ciphertext"),
  apiKeyLast4: text("api_key_last4"),
  model: text("model").notNull().default("claude-opus-5-5"),
  conversionsEnabled: boolean("conversions_enabled").notNull().default(true),
  monthlyBudget: doublePrecision("monthly_budget"),
  budgetCurrency: text("budget_currency").notNull().default("USD"),
  usdToInr: doublePrecision("usd_to_inr").notNull().default(84),
  defaultMargin: doublePrecision("default_margin").notNull().default(0.125),
  maxConversionsPerHour: integer("max_conversions_per_hour").notNull().default(10),
  budgetAlertMonth: text("budget_alert_month"),
  budgetAlertLevel: integer("budget_alert_level").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const apiCalls = bom.table(
  "api_calls",
  {
    id: serial("id").primaryKey(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    userId: uuid("user_id"),
    jobId: uuid("job_id"),
    kind: text("kind").notNull(), // extract | test | health
    model: text("model").notNull(),
    success: boolean("success").notNull(),
    statusCode: integer("status_code"),
    errorType: text("error_type"), // auth | rate_limit | timeout | overloaded | refusal | other
    message: text("message"),
    latencyMs: integer("latency_ms").notNull().default(0),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    costUsd: doublePrecision("cost_usd").notNull().default(0),
    attempt: integer("attempt").notNull().default(1),
  },
  (t) => [index("api_calls_created_idx").on(t.createdAt), index("api_calls_job_idx").on(t.jobId)],
);

export const priceFiles = bom.table("price_files", {
  id: uuid("id").primaryKey().defaultRandom(),
  version: integer("version").notNull(),
  filename: text("filename").notNull(),
  uploadedBy: uuid("uploaded_by"),
  active: boolean("active").notNull().default(false),
  rowCount: integer("row_count").notNull().default(0),
  data: bytea("data").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const priceItems = bom.table(
  "price_items",
  {
    id: serial("id").primaryKey(),
    priceFileId: uuid("price_file_id")
      .notNull()
      .references(() => priceFiles.id, { onDelete: "cascade" }),
    rowNumber: integer("row_number").notNull(),
    terexPn: text("terex_pn"),
    whereUsed: text("where_used"),
    drgSheetNo: text("drg_sheet_no"),
    description: text("description"),
    mpn: text("mpn"),
    mpnNorm: text("mpn_norm"),
    make: text("make"),
    uom: text("uom"),
    qty: doublePrecision("qty"),
    listPrice: doublePrecision("list_price"),
    disc: doublePrecision("disc"),
    unitPrice: doublePrecision("unit_price"),
    margin: doublePrecision("margin"),
    terexUnitPrice: doublePrecision("terex_unit_price"),
    totalPrice: doublePrecision("total_price"),
    tagNo: text("tag_no"),
  },
  (t) => [index("price_items_file_idx").on(t.priceFileId), index("price_items_mpn_idx").on(t.mpnNorm)],
);

export const templates = bom.table("templates", {
  id: uuid("id").primaryKey().defaultRandom(),
  filename: text("filename").notNull(),
  data: bytea("data").notNull(),
  active: boolean("active").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const matchingRules = bom.table("matching_rules", {
  id: serial("id").primaryKey(),
  deviceType: text("device_type").notNull(),
  rating: text("rating").notNull(),
  qualifier: text("qualifier"),
  mpn: text("mpn").notNull(),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const jobs = bom.table(
  "jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull(),
    filename: text("filename").notNull(),
    // uploading | analyzing | extracting | matching | review | approved | failed
    status: text("status").notNull().default("uploading"),
    fileSize: integer("file_size").notNull().default(0),
    chunkCount: integer("chunk_count").notNull().default(1),
    pdf: bytea("pdf"),
    pageCount: integer("page_count").notNull().default(0),
    pagesDone: integer("pages_done").notNull().default(0),
    priceFileId: uuid("price_file_id"),
    margin: doublePrecision("margin").notNull().default(0.125),
    pages: jsonb("pages").$type<unknown[]>().notNull().default([]),
    anomalies: jsonb("anomalies").$type<unknown[]>().notNull().default([]),
    counts: jsonb("counts").$type<Record<string, unknown>>().notNull().default({}),
    changesReport: jsonb("changes_report").$type<Record<string, unknown> | null>(),
    parentJobId: uuid("parent_job_id"),
    error: text("error"),
    costUsd: doublePrecision("cost_usd").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
  },
  (t) => [index("jobs_user_idx").on(t.userId), index("jobs_created_idx").on(t.createdAt)],
);

export const jobChunks = bom.table("job_chunks", {
  id: serial("id").primaryKey(),
  jobId: uuid("job_id")
    .notNull()
    .references(() => jobs.id, { onDelete: "cascade" }),
  idx: integer("idx").notNull(),
  data: bytea("data").notNull(),
});

export const jobLines = bom.table(
  "job_lines",
  {
    id: serial("id").primaryKey(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    terexPn: text("terex_pn"),
    whereUsed: text("where_used"),
    drgSheetNo: text("drg_sheet_no"),
    description: text("description"),
    mpn: text("mpn"),
    make: text("make"),
    uom: text("uom"),
    qty: doublePrecision("qty").notNull().default(1),
    listPrice: doublePrecision("list_price"),
    disc: doublePrecision("disc"),
    margin: doublePrecision("margin").notNull().default(0.125),
    status: text("status").notNull().default("matched"), // matched | conflict | not_found | anomaly | manual
    flags: jsonb("flags").$type<string[]>().notNull().default([]),
    alternatives: jsonb("alternatives").$type<unknown[]>().notNull().default([]),
    notes: text("notes"),
    sourceKey: text("source_key"),
    sourceCount: integer("source_count"),
  },
  (t) => [index("job_lines_job_idx").on(t.jobId)],
);

export type User = typeof users.$inferSelect;
export type Settings = typeof settings.$inferSelect;
export type Job = typeof jobs.$inferSelect;
export type JobLine = typeof jobLines.$inferSelect;
export type PriceItem = typeof priceItems.$inferSelect;
export type MatchingRule = typeof matchingRules.$inferSelect;
