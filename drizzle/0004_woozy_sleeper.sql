CREATE TABLE "mention_list_members" (
	"id" serial PRIMARY KEY NOT NULL,
	"list_id" integer NOT NULL,
	"pn" text,
	"lid" text,
	"label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mention_lists" (
	"id" serial PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"label" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mention_list_members" ADD CONSTRAINT "mention_list_members_list_id_mention_lists_id_fk" FOREIGN KEY ("list_id") REFERENCES "public"."mention_lists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mention_lists" ADD CONSTRAINT "mention_lists_created_by_agents_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mention_list_members_list_idx" ON "mention_list_members" USING btree ("list_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mention_lists_slug_uq" ON "mention_lists" USING btree ("slug");