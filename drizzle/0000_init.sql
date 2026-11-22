CREATE SCHEMA IF NOT EXISTS "bom";
--> statement-breakpoint
CREATE TYPE "bom"."role" AS ENUM('ADMIN', 'USER');--> statement-breakpoint
CREATE TABLE "bom"."api_calls" (
	"id" serial PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" uuid,
	"job_id" uuid,
	"kind" text NOT NULL,
	"model" text NOT NULL,
	"success" boolean NOT NULL,
	"status_code" integer,
	"error_type" text,
	"message" text,
	"latency_ms" integer DEFAULT 0 NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" double precision DEFAULT 0 NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bom"."job_chunks" (
	"id" serial PRIMARY KEY NOT NULL,
	"job_id" uuid NOT NULL,
	"idx" integer NOT NULL,
	"data" "bytea" NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bom"."job_lines" (
	"id" serial PRIMARY KEY NOT NULL,
	"job_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"terex_pn" text,
	"where_used" text,
	"drg_sheet_no" text,
	"description" text,
	"mpn" text,
	"make" text,
	"uom" text,
	"qty" double precision DEFAULT 1 NOT NULL,
	"list_price" double precision,
	"disc" double precision,
	"margin" double precision DEFAULT 0.125 NOT NULL,
	"status" text DEFAULT 'matched' NOT NULL,
	"flags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"alternatives" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"notes" text,
	"source_key" text,
	"source_count" integer
);
--> statement-breakpoint
CREATE TABLE "bom"."jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"filename" text NOT NULL,
	"status" text DEFAULT 'uploading' NOT NULL,
	"file_size" integer DEFAULT 0 NOT NULL,
	"chunk_count" integer DEFAULT 1 NOT NULL,
	"pdf" "bytea",
	"page_count" integer DEFAULT 0 NOT NULL,
	"pages_done" integer DEFAULT 0 NOT NULL,
	"price_file_id" uuid,
	"margin" double precision DEFAULT 0.125 NOT NULL,
	"pages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"anomalies" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"changes_report" jsonb,
	"parent_job_id" uuid,
	"error" text,
	"cost_usd" double precision DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"approved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "bom"."matching_rules" (
	"id" serial PRIMARY KEY NOT NULL,
	"device_type" text NOT NULL,
	"rating" text NOT NULL,
	"qualifier" text,
	"mpn" text NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bom"."price_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version" integer NOT NULL,
	"filename" text NOT NULL,
	"uploaded_by" uuid,
	"active" boolean DEFAULT false NOT NULL,
	"row_count" integer DEFAULT 0 NOT NULL,
	"data" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bom"."price_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"price_file_id" uuid NOT NULL,
	"row_number" integer NOT NULL,
	"terex_pn" text,
	"where_used" text,
	"drg_sheet_no" text,
	"description" text,
	"mpn" text,
	"mpn_norm" text,
	"make" text,
	"uom" text,
	"qty" double precision,
	"list_price" double precision,
	"disc" double precision,
	"unit_price" double precision,
	"margin" double precision,
	"terex_unit_price" double precision,
	"total_price" double precision,
	"tag_no" text
);
--> statement-breakpoint
CREATE TABLE "bom"."settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"api_key_ciphertext" text,
	"api_key_last4" text,
	"model" text DEFAULT 'claude-opus-5-5' NOT NULL,
	"conversions_enabled" boolean DEFAULT true NOT NULL,
	"monthly_budget" double precision,
	"budget_currency" text DEFAULT 'USD' NOT NULL,
	"usd_to_inr" double precision DEFAULT 84 NOT NULL,
	"default_margin" double precision DEFAULT 0.125 NOT NULL,
	"max_conversions_per_hour" integer DEFAULT 10 NOT NULL,
	"budget_alert_month" text,
	"budget_alert_level" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bom"."templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"filename" text NOT NULL,
	"data" "bytea" NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bom"."users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"password_hash" text NOT NULL,
	"role" "bom"."role" DEFAULT 'USER' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"must_change_password" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_login_at" timestamp with time zone,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "bom"."job_chunks" ADD CONSTRAINT "job_chunks_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "bom"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bom"."job_lines" ADD CONSTRAINT "job_lines_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "bom"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bom"."price_items" ADD CONSTRAINT "price_items_price_file_id_price_files_id_fk" FOREIGN KEY ("price_file_id") REFERENCES "bom"."price_files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_calls_created_idx" ON "bom"."api_calls" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "api_calls_job_idx" ON "bom"."api_calls" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "job_lines_job_idx" ON "bom"."job_lines" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "jobs_user_idx" ON "bom"."jobs" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "jobs_created_idx" ON "bom"."jobs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "price_items_file_idx" ON "bom"."price_items" USING btree ("price_file_id");--> statement-breakpoint
CREATE INDEX "price_items_mpn_idx" ON "bom"."price_items" USING btree ("mpn_norm");