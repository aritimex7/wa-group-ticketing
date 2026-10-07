ALTER TYPE "public"."trigger_type" ADD VALUE 'dm';--> statement-breakpoint
ALTER TABLE "groups" ADD COLUMN "is_dm" boolean DEFAULT false NOT NULL;