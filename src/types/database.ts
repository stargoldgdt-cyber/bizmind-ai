/**
 * Database types.
 *
 * These mirror `supabase/migrations/0001_identity_and_tenancy.sql` and give
 * every Supabase query full type safety — a typo in a column name becomes a
 * compile error instead of a runtime surprise.
 *
 * KEEP IN SYNC WITH THE MIGRATIONS. When the schema changes, either update
 * this file in the same commit or regenerate it:
 *
 *   npx supabase gen types typescript --project-id <ref> > src/types/database.ts
 *
 * Written by hand for now so the project is not blocked on CLI setup.
 */

export type BusinessRole = "VIEWER" | "STAFF" | "ADMIN" | "OWNER"

/** Roles ordered by privilege. Index = rank, so comparisons are meaningful. */
export const BUSINESS_ROLES: readonly BusinessRole[] = [
  "VIEWER",
  "STAFF",
  "ADMIN",
  "OWNER",
] as const

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  public: {
    Tables: {
      profiles: {
        Row: {
          id: string
          email: string
          full_name: string | null
          avatar_url: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id: string
          email: string
          full_name?: string | null
          avatar_url?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          email?: string
          full_name?: string | null
          avatar_url?: string | null
        }
        Relationships: []
      }

      businesses: {
        Row: {
          id: string
          name: string
          slug: string
          currency: string
          timezone: string
          created_by: string
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          name: string
          slug: string
          currency?: string
          timezone?: string
          created_by: string
          created_at?: string
          updated_at?: string
        }
        Update: {
          name?: string
          slug?: string
          currency?: string
          timezone?: string
        }
        Relationships: [
          {
            foreignKeyName: "businesses_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }

      business_members: {
        Row: {
          id: string
          business_id: string
          user_id: string
          role: BusinessRole
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          business_id: string
          user_id: string
          role?: BusinessRole
          created_at?: string
          updated_at?: string
        }
        Update: {
          role?: BusinessRole
        }
        /**
         * These describe the foreign keys to the Supabase client so that an
         * embedded select such as `.select("role, businesses(*)")` is typed as
         * a single object rather than an array. Without them the join comes
         * back as `unknown` and every caller needs a cast.
         */
        Relationships: [
          {
            foreignKeyName: "business_members_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "business_members_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
    }

    Views: Record<never, never>

    Functions: {
      create_business: {
        Args: {
          p_name: string
          p_slug: string
          p_currency?: string
          p_timezone?: string
        }
        Returns: Database["public"]["Tables"]["businesses"]["Row"]
      }
      current_user_business_ids: {
        Args: Record<string, never>
        Returns: string[]
      }
      current_user_has_role: {
        Args: { p_business_id: string; p_roles: BusinessRole[] }
        Returns: boolean
      }
      shares_business_with_current_user: {
        Args: { p_user_id: string }
        Returns: boolean
      }
    }

    Enums: {
      business_role: BusinessRole
    }

    CompositeTypes: Record<never, never>
  }
}

/* ---- Convenience aliases used across the app ----------------------------- */

export type Profile = Database["public"]["Tables"]["profiles"]["Row"]
export type Business = Database["public"]["Tables"]["businesses"]["Row"]
export type BusinessMember = Database["public"]["Tables"]["business_members"]["Row"]

/** A business plus the calling user's role in it. */
export type BusinessWithRole = Business & { role: BusinessRole }
