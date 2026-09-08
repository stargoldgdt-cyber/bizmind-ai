/**
 * Database types.
 *
 * These mirror the migrations in `supabase/migrations/` and give every
 * Supabase query full type safety — a typo in a column name becomes a compile
 * error instead of a runtime surprise.
 *
 * KEEP IN SYNC WITH THE MIGRATIONS. When the schema changes, update this file
 * in the same commit, or regenerate it:
 *
 *   npx supabase gen types typescript --project-id <ref> > src/types/database.ts
 *
 * A mismatch between this file and the real schema produces code that compiles
 * and then fails at runtime, which is the worst kind of bug. Treat these types
 * as part of the migration, not as an afterthought.
 *
 * MONEY AND QUANTITIES
 * --------------------
 * Every money and quantity column is `numeric(20,4)` in PostgreSQL and is
 * typed here as `string`. That is deliberate, not an oversight.
 *
 * PostgREST returns numerics as JSON strings to preserve precision. Parsing
 * one into a JavaScript number silently converts it to binary floating point,
 * where 0.10 cannot be represented exactly and the error compounds across
 * aggregation. Keeping them as strings makes it impossible to do financial
 * arithmetic in JavaScript by accident — which is the rule anyway: the
 * database computes every figure, the application only displays it.
 */

/* ---- Enumerations -------------------------------------------------------- */

export type BusinessRole = "VIEWER" | "STAFF" | "ADMIN" | "OWNER"

/** Roles ordered by privilege. Index = rank, so comparisons are meaningful. */
export const BUSINESS_ROLES: readonly BusinessRole[] = [
  "VIEWER",
  "STAFF",
  "ADMIN",
  "OWNER",
] as const

export type ChannelType =
  | "WEBSITE"
  | "SHOPIFY"
  | "WOOCOMMERCE"
  | "AMAZON"
  | "DARAZ"
  | "EBAY"
  | "FACEBOOK"
  | "INSTAGRAM"
  | "POS"
  | "MANUAL"
  | "OTHER"

export type OrderStatus =
  | "PENDING"
  | "CONFIRMED"
  | "FULFILLED"
  | "CANCELLED"
  | "REFUNDED"
  | "PARTIALLY_REFUNDED"

export type PaymentStatus =
  | "PENDING"
  | "PAID"
  | "FAILED"
  | "REFUNDED"
  | "PARTIALLY_REFUNDED"

export type ReturnStatus =
  | "REQUESTED"
  | "APPROVED"
  | "RECEIVED"
  | "REFUNDED"
  | "REJECTED"

export type InventoryMovementType =
  | "PURCHASE"
  | "SALE"
  | "RETURN"
  | "ADJUSTMENT"
  | "TRANSFER"
  | "DAMAGE"
  | "INITIAL"

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

/**
 * A `numeric` column. Always a string on the wire — see the note above.
 * Never do arithmetic on this in JavaScript; aggregate in SQL instead.
 */
type Numeric = string

/** Every business-owned row carries these. */
type Tenanted = {
  id: string
  business_id: string
  created_at: string
}

/** Columns present on rows that can originate in an external system. */
type Syncable = {
  source: ChannelType | null
  external_id: string | null
}

export type Database = {
  public: {
    Tables: {
      /* ---- Identity and tenancy (migration 0001) ------------------------ */

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
        }
        Update: { role?: BusinessRole }
        /**
         * Declaring the foreign keys lets an embedded select such as
         * `.select("role, businesses(*)")` be typed as a single object rather
         * than an array. Without them the join comes back as `unknown`.
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

      /* ---- Universal data model (migration 0002) ------------------------ */

      channels: {
        Row: Tenanted & {
          name: string
          type: ChannelType
          is_active: boolean
          updated_at: string
        }
        Insert: {
          business_id: string
          name: string
          type?: ChannelType
          is_active?: boolean
        }
        Update: { name?: string; type?: ChannelType; is_active?: boolean }
        Relationships: [
          {
            foreignKeyName: "channels_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
        ]
      }

      customers: {
        Row: Tenanted &
          Syncable & {
            email: string | null
            phone: string | null
            full_name: string | null
            city: string | null
            country: string | null
            updated_at: string
          }
        Insert: {
          business_id: string
          source?: ChannelType | null
          external_id?: string | null
          email?: string | null
          phone?: string | null
          full_name?: string | null
          city?: string | null
          country?: string | null
        }
        Update: {
          email?: string | null
          phone?: string | null
          full_name?: string | null
          city?: string | null
          country?: string | null
        }
        Relationships: []
      }

      products: {
        Row: Tenanted &
          Syncable & {
            sku: string | null
            name: string
            description: string | null
            category: string | null
            brand: string | null
            is_active: boolean
            updated_at: string
          }
        Insert: {
          business_id: string
          source?: ChannelType | null
          external_id?: string | null
          sku?: string | null
          name: string
          description?: string | null
          category?: string | null
          brand?: string | null
          is_active?: boolean
        }
        Update: {
          sku?: string | null
          name?: string
          description?: string | null
          category?: string | null
          brand?: string | null
          is_active?: boolean
        }
        Relationships: []
      }

      product_variants: {
        Row: Tenanted &
          Syncable & {
            product_id: string
            sku: string | null
            name: string | null
            attributes: Json
            unit_price: Numeric | null
            unit_cost: Numeric | null
            barcode: string | null
            is_active: boolean
            updated_at: string
          }
        Insert: {
          business_id: string
          product_id: string
          source?: ChannelType | null
          external_id?: string | null
          sku?: string | null
          name?: string | null
          attributes?: Json
          unit_price?: Numeric | number | null
          unit_cost?: Numeric | number | null
          barcode?: string | null
          is_active?: boolean
        }
        Update: {
          sku?: string | null
          name?: string | null
          attributes?: Json
          unit_price?: Numeric | number | null
          unit_cost?: Numeric | number | null
          barcode?: string | null
          is_active?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "product_variants_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
        ]
      }

      inventory: {
        Row: Tenanted & {
          variant_id: string
          location: string
          quantity_on_hand: Numeric
          quantity_reserved: Numeric
          reorder_point: Numeric | null
          updated_at: string
        }
        Insert: {
          business_id: string
          variant_id: string
          location?: string
          quantity_on_hand?: Numeric | number
          quantity_reserved?: Numeric | number
          reorder_point?: Numeric | number | null
        }
        Update: {
          quantity_on_hand?: Numeric | number
          quantity_reserved?: Numeric | number
          reorder_point?: Numeric | number | null
        }
        Relationships: [
          {
            foreignKeyName: "inventory_variant_id_fkey"
            columns: ["variant_id"]
            isOneToOne: false
            referencedRelation: "product_variants"
            referencedColumns: ["id"]
          },
        ]
      }

      inventory_movements: {
        Row: Tenanted & {
          variant_id: string
          location: string
          movement_type: InventoryMovementType
          /** Signed. Negative when stock leaves. Summing reconstructs stock. */
          quantity: Numeric
          unit_cost: Numeric | null
          reference_type: string | null
          reference_id: string | null
          note: string | null
          occurred_at: string
        }
        Insert: {
          business_id: string
          variant_id: string
          location?: string
          movement_type: InventoryMovementType
          quantity: Numeric | number
          unit_cost?: Numeric | number | null
          reference_type?: string | null
          reference_id?: string | null
          note?: string | null
          occurred_at?: string
        }
        Update: { note?: string | null }
        Relationships: [
          {
            foreignKeyName: "inventory_movements_variant_id_fkey"
            columns: ["variant_id"]
            isOneToOne: false
            referencedRelation: "product_variants"
            referencedColumns: ["id"]
          },
        ]
      }

      orders: {
        Row: Tenanted &
          Syncable & {
            channel_id: string | null
            customer_id: string | null
            order_number: string | null
            status: OrderStatus
            currency: string
            subtotal: Numeric
            discount_total: Numeric
            tax_total: Numeric
            shipping_total: Numeric
            /** Marketplace commission, processing, fulfilment. */
            fee_total: Numeric
            total: Numeric
            placed_at: string
            cancelled_at: string | null
            updated_at: string
          }
        Insert: {
          business_id: string
          channel_id?: string | null
          customer_id?: string | null
          source?: ChannelType | null
          external_id?: string | null
          order_number?: string | null
          status?: OrderStatus
          currency: string
          subtotal?: Numeric | number
          discount_total?: Numeric | number
          tax_total?: Numeric | number
          shipping_total?: Numeric | number
          fee_total?: Numeric | number
          total?: Numeric | number
          placed_at?: string
          cancelled_at?: string | null
        }
        Update: {
          channel_id?: string | null
          customer_id?: string | null
          order_number?: string | null
          status?: OrderStatus
          subtotal?: Numeric | number
          discount_total?: Numeric | number
          tax_total?: Numeric | number
          shipping_total?: Numeric | number
          fee_total?: Numeric | number
          total?: Numeric | number
          cancelled_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "orders_channel_id_fkey"
            columns: ["channel_id"]
            isOneToOne: false
            referencedRelation: "channels"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "orders_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
        ]
      }

      order_items: {
        Row: Tenanted & {
          order_id: string
          variant_id: string | null
          product_id: string | null
          sku: string | null
          name: string | null
          quantity: Numeric
          unit_price: Numeric
          /** Cost AT THE TIME OF SALE, not today's cost. Drives true COGS. */
          unit_cost: Numeric | null
          discount: Numeric
          tax: Numeric
          line_total: Numeric
        }
        Insert: {
          business_id: string
          order_id: string
          variant_id?: string | null
          product_id?: string | null
          sku?: string | null
          name?: string | null
          quantity: Numeric | number
          unit_price?: Numeric | number
          unit_cost?: Numeric | number | null
          discount?: Numeric | number
          tax?: Numeric | number
          line_total?: Numeric | number
        }
        Update: {
          quantity?: Numeric | number
          unit_price?: Numeric | number
          unit_cost?: Numeric | number | null
          discount?: Numeric | number
          tax?: Numeric | number
          line_total?: Numeric | number
        }
        Relationships: [
          {
            foreignKeyName: "order_items_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "order_items_variant_id_fkey"
            columns: ["variant_id"]
            isOneToOne: false
            referencedRelation: "product_variants"
            referencedColumns: ["id"]
          },
        ]
      }

      payments: {
        Row: Tenanted &
          Syncable & {
            order_id: string | null
            method: string | null
            status: PaymentStatus
            amount: Numeric
            fee: Numeric
            currency: string
            paid_at: string | null
            updated_at: string
          }
        Insert: {
          business_id: string
          order_id?: string | null
          source?: ChannelType | null
          external_id?: string | null
          method?: string | null
          status?: PaymentStatus
          amount?: Numeric | number
          fee?: Numeric | number
          currency: string
          paid_at?: string | null
        }
        Update: {
          status?: PaymentStatus
          amount?: Numeric | number
          fee?: Numeric | number
          paid_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "payments_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
        ]
      }

      returns: {
        Row: Tenanted &
          Syncable & {
            order_id: string | null
            status: ReturnStatus
            reason: string | null
            refund_amount: Numeric
            currency: string
            restocked: boolean
            occurred_at: string
            updated_at: string
          }
        Insert: {
          business_id: string
          order_id?: string | null
          source?: ChannelType | null
          external_id?: string | null
          status?: ReturnStatus
          reason?: string | null
          refund_amount?: Numeric | number
          currency: string
          restocked?: boolean
          occurred_at?: string
        }
        Update: {
          status?: ReturnStatus
          reason?: string | null
          refund_amount?: Numeric | number
          restocked?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "returns_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
        ]
      }

      expenses: {
        Row: Tenanted &
          Syncable & {
            category: string
            description: string | null
            vendor: string | null
            amount: Numeric
            currency: string
            is_recurring: boolean
            incurred_at: string
            updated_at: string
          }
        Insert: {
          business_id: string
          category?: string
          description?: string | null
          vendor?: string | null
          amount: Numeric | number
          currency: string
          is_recurring?: boolean
          incurred_at?: string
          source?: ChannelType | null
          external_id?: string | null
        }
        Update: {
          category?: string
          description?: string | null
          vendor?: string | null
          amount?: Numeric | number
          is_recurring?: boolean
          incurred_at?: string
        }
        Relationships: []
      }

      audit_logs: {
        Row: Tenanted & {
          actor_id: string | null
          action: string
          entity_type: string
          entity_id: string | null
          before_data: Json | null
          after_data: Json | null
        }
        /**
         * Append-only. There is no INSERT, UPDATE or DELETE policy — entries
         * are written by `write_audit_log()`, which stamps the actor from the
         * session so it cannot be forged. `never` makes writing one from
         * application code a compile error.
         */
        Insert: never
        Update: never
        Relationships: [
          {
            foreignKeyName: "audit_logs_actor_id_fkey"
            columns: ["actor_id"]
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
      write_audit_log: {
        Args: {
          p_business_id: string
          p_action: string
          p_entity_type: string
          p_entity_id?: string | null
          p_before?: Json | null
          p_after?: Json | null
        }
        Returns: string
      }

      /* ---- Metrics (migration 0003) ------------------------------------
       * SECURITY INVOKER, so RLS applies inside them. Every money field
       * comes back as a string, for the reasons in the header note. */

      dashboard_summary: {
        Args: { p_business_id: string; p_from: string; p_to: string }
        Returns: {
          revenue: Numeric
          order_count: number
          units_sold: Numeric
          cogs: Numeric
          fees: Numeric
          gross_profit: Numeric
          gross_margin: Numeric | null
          expenses: Numeric
          net_profit: Numeric
          net_margin: Numeric | null
          avg_order_value: Numeric | null
          customer_count: number
          refunds: Numeric
          items_total: number
          items_with_cost: number
        }[]
      }

      channel_performance: {
        Args: { p_business_id: string; p_from: string; p_to: string }
        Returns: {
          channel_id: string | null
          channel_name: string
          channel_type: ChannelType
          revenue: Numeric
          order_count: number
          cogs: Numeric
          fees: Numeric
          gross_profit: Numeric
          gross_margin: Numeric | null
        }[]
      }
    }

    Enums: {
      business_role: BusinessRole
      channel_type: ChannelType
      order_status: OrderStatus
      payment_status: PaymentStatus
      return_status: ReturnStatus
      inventory_movement_type: InventoryMovementType
    }

    CompositeTypes: Record<never, never>
  }
}

/* ---- Convenience aliases ------------------------------------------------- */

type T = Database["public"]["Tables"]

export type Profile = T["profiles"]["Row"]
export type Business = T["businesses"]["Row"]
export type BusinessMember = T["business_members"]["Row"]
export type Channel = T["channels"]["Row"]
export type Customer = T["customers"]["Row"]
export type Product = T["products"]["Row"]
export type ProductVariant = T["product_variants"]["Row"]
export type InventoryRecord = T["inventory"]["Row"]
export type InventoryMovement = T["inventory_movements"]["Row"]
export type Order = T["orders"]["Row"]
export type OrderItem = T["order_items"]["Row"]
export type Payment = T["payments"]["Row"]
export type ReturnRecord = T["returns"]["Row"]
export type Expense = T["expenses"]["Row"]
export type AuditLog = T["audit_logs"]["Row"]

/** A business plus the calling user's role in it. */
export type BusinessWithRole = Business & { role: BusinessRole }
