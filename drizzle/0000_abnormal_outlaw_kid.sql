CREATE TYPE "public"."bucket_kind" AS ENUM('ignored', 'needs_review');--> statement-breakpoint
CREATE TYPE "public"."direction" AS ENUM('in', 'out');--> statement-breakpoint
CREATE TYPE "public"."gateway_state" AS ENUM('connected', 'disconnected', 'qr_required', 'error');--> statement-breakpoint
CREATE TYPE "public"."msg_type" AS ENUM('text', 'image', 'video', 'document', 'audio', 'sticker', 'location', 'other');--> statement-breakpoint
CREATE TYPE "public"."outbox_status" AS ENUM('holding', 'sending', 'sent', 'failed', 'canceled');--> statement-breakpoint
CREATE TYPE "public"."role" AS ENUM('agent', 'leader');--> statement-breakpoint
CREATE TYPE "public"."ticket_action" AS ENUM('created', 'claim', 'release', 'auto_release', 'takeover', 'reply_sent', 'send_failed', 'mark_on_check', 'mark_resolved', 'mark_not_for_us', 'bulk_closed', 'note_updated', 'undo');--> statement-breakpoint
CREATE TYPE "public"."ticket_status" AS ENUM('open', 'on_progress', 'closed', 'not_for_us');--> statement-breakpoint
CREATE TYPE "public"."trigger_type" AS ENUM('mention', 'reply');--> statement-breakpoint
CREATE TABLE "agent_seen" (
	"agent_id" integer NOT NULL,
	"ticket_id" integer NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_seen_agent_id_ticket_id_pk" PRIMARY KEY("agent_id","ticket_id")
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"username" text NOT NULL,
	"password_hash" text NOT NULL,
	"signature_code" text NOT NULL,
	"role" "role" DEFAULT 'agent' NOT NULL,
	"shift" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "archive_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"group_jid" text,
	"group_label" text,
	"sender_name" text,
	"body" text NOT NULL,
	"sent_at" timestamp with time zone NOT NULL,
	"source_file" text NOT NULL,
	"line_no" integer,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gateway_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"instance" text NOT NULL,
	"state" "gateway_state" NOT NULL,
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "groups" (
	"jid" text PRIMARY KEY NOT NULL,
	"name" text,
	"is_monitored" boolean DEFAULT false NOT NULL,
	"client_label" text,
	"sla_first_response_min" integer,
	"sla_resolution_min" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"acknowledged_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "ignored_phrases" (
	"id" serial PRIMARY KEY NOT NULL,
	"phrase" text NOT NULL,
	"match_mode" text DEFAULT 'exact' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "internal_numbers" (
	"id" serial PRIMARY KEY NOT NULL,
	"label" text,
	"pn" text,
	"lid" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"stanza_id" text PRIMARY KEY NOT NULL,
	"group_jid" text NOT NULL,
	"sender_pn" text,
	"sender_lid" text,
	"sender_push_name" text,
	"direction" "direction" NOT NULL,
	"msg_type" "msg_type" DEFAULT 'text' NOT NULL,
	"body" text,
	"reply_to_stanza_id" text,
	"reply_to_sender_pn" text,
	"reply_to_sender_lid" text,
	"quoted_snippet" text,
	"media_meta" jsonb,
	"agent_id" integer,
	"signature_code" text,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"is_edited" boolean DEFAULT false NOT NULL,
	"raw_payload" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"detail" jsonb,
	"for_role" "role" DEFAULT 'leader' NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"idempotency_key" text NOT NULL,
	"ticket_id" integer,
	"group_jid" text NOT NULL,
	"agent_id" integer NOT NULL,
	"body" text NOT NULL,
	"mentions" jsonb,
	"attachment" jsonb,
	"reply_to_stanza_id" text,
	"also_close_ticket_ids" jsonb,
	"is_on_check" boolean DEFAULT false NOT NULL,
	"mark_resolved" boolean DEFAULT false NOT NULL,
	"status" "outbox_status" DEFAULT 'holding' NOT NULL,
	"release_at" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"sent_stanza_id" text,
	"wa_ack" integer,
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quick_replies" (
	"id" serial PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" integer NOT NULL,
	"ip" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" integer
);
--> statement-breakpoint
CREATE TABLE "settings_audit" (
	"id" serial PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"from_value" jsonb,
	"to_value" jsonb,
	"changed_by" integer,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticket_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"ticket_id" integer NOT NULL,
	"agent_id" integer,
	"action" "ticket_action" NOT NULL,
	"from_value" text,
	"to_value" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tickets" (
	"id" serial PRIMARY KEY NOT NULL,
	"stanza_id" text NOT NULL,
	"group_jid" text NOT NULL,
	"status" "ticket_status" DEFAULT 'open' NOT NULL,
	"trigger_type" "trigger_type" NOT NULL,
	"likely_not_ours" boolean DEFAULT false NOT NULL,
	"claimed_by" integer,
	"claimed_at" timestamp with time zone,
	"first_response_at" timestamp with time zone,
	"first_responder_id" integer,
	"resolved_at" timestamp with time zone,
	"resolved_by" integer,
	"closed_at" timestamp with time zone,
	"closed_by" integer,
	"sla_target_fr_min" integer NOT NULL,
	"sla_target_res_min" integer NOT NULL,
	"note" text,
	"triggered_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "triage_bucket" (
	"id" serial PRIMARY KEY NOT NULL,
	"stanza_id" text NOT NULL,
	"group_jid" text NOT NULL,
	"kind" "bucket_kind" NOT NULL,
	"matched_rule" text NOT NULL,
	"reviewed_by" integer,
	"reviewed_at" timestamp with time zone,
	"promoted_ticket_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_seen" ADD CONSTRAINT "agent_seen_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_seen" ADD CONSTRAINT "agent_seen_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ignored_phrases" ADD CONSTRAINT "ignored_phrases_created_by_agents_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "internal_numbers" ADD CONSTRAINT "internal_numbers_created_by_agents_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_group_jid_groups_jid_fk" FOREIGN KEY ("group_jid") REFERENCES "public"."groups"("jid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_updated_by_agents_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settings_audit" ADD CONSTRAINT "settings_audit_changed_by_agents_id_fk" FOREIGN KEY ("changed_by") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_events" ADD CONSTRAINT "ticket_events_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_events" ADD CONSTRAINT "ticket_events_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_stanza_id_messages_stanza_id_fk" FOREIGN KEY ("stanza_id") REFERENCES "public"."messages"("stanza_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_group_jid_groups_jid_fk" FOREIGN KEY ("group_jid") REFERENCES "public"."groups"("jid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_claimed_by_agents_id_fk" FOREIGN KEY ("claimed_by") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_first_responder_id_agents_id_fk" FOREIGN KEY ("first_responder_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_resolved_by_agents_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_closed_by_agents_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "triage_bucket" ADD CONSTRAINT "triage_bucket_stanza_id_messages_stanza_id_fk" FOREIGN KEY ("stanza_id") REFERENCES "public"."messages"("stanza_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "triage_bucket" ADD CONSTRAINT "triage_bucket_reviewed_by_agents_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "triage_bucket" ADD CONSTRAINT "triage_bucket_promoted_ticket_id_tickets_id_fk" FOREIGN KEY ("promoted_ticket_id") REFERENCES "public"."tickets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agents_username_uq" ON "agents" USING btree ("username");--> statement-breakpoint
CREATE UNIQUE INDEX "agents_signature_code_uq" ON "agents" USING btree ("signature_code");--> statement-breakpoint
CREATE INDEX "archive_sent_at_idx" ON "archive_messages" USING btree ("sent_at");--> statement-breakpoint
CREATE INDEX "archive_body_fts_idx" ON "archive_messages" USING gin (to_tsvector('simple', "body"));--> statement-breakpoint
CREATE INDEX "gateway_events_created_idx" ON "gateway_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "internal_numbers_pn_idx" ON "internal_numbers" USING btree ("pn");--> statement-breakpoint
CREATE INDEX "internal_numbers_lid_idx" ON "internal_numbers" USING btree ("lid");--> statement-breakpoint
CREATE INDEX "messages_group_created_idx" ON "messages" USING btree ("group_jid","created_at");--> statement-breakpoint
CREATE INDEX "messages_reply_to_idx" ON "messages" USING btree ("reply_to_stanza_id");--> statement-breakpoint
CREATE INDEX "messages_agent_idx" ON "messages" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "messages_sender_pn_idx" ON "messages" USING btree ("sender_pn");--> statement-breakpoint
CREATE INDEX "messages_sender_lid_idx" ON "messages" USING btree ("sender_lid");--> statement-breakpoint
CREATE INDEX "messages_body_fts_idx" ON "messages" USING gin (to_tsvector('simple', coalesce("body", '')));--> statement-breakpoint
CREATE INDEX "notifications_unread_idx" ON "notifications" USING btree ("for_role","read_at");--> statement-breakpoint
CREATE UNIQUE INDEX "outbox_idempotency_uq" ON "outbox" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "outbox_due_idx" ON "outbox" USING btree ("status","release_at");--> statement-breakpoint
CREATE INDEX "outbox_ticket_idx" ON "outbox" USING btree ("ticket_id");--> statement-breakpoint
CREATE INDEX "sessions_agent_idx" ON "sessions" USING btree ("agent_id","last_seen_at");--> statement-breakpoint
CREATE INDEX "settings_audit_key_idx" ON "settings_audit" USING btree ("key","changed_at");--> statement-breakpoint
CREATE INDEX "ticket_events_ticket_idx" ON "ticket_events" USING btree ("ticket_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "tickets_stanza_uq" ON "tickets" USING btree ("stanza_id");--> statement-breakpoint
CREATE INDEX "tickets_status_idx" ON "tickets" USING btree ("status","triggered_at");--> statement-breakpoint
CREATE INDEX "tickets_group_status_idx" ON "tickets" USING btree ("group_jid","status");--> statement-breakpoint
CREATE INDEX "tickets_claimed_idx" ON "tickets" USING btree ("claimed_by");--> statement-breakpoint
CREATE UNIQUE INDEX "triage_stanza_uq" ON "triage_bucket" USING btree ("stanza_id");--> statement-breakpoint
CREATE INDEX "triage_kind_idx" ON "triage_bucket" USING btree ("kind","created_at");