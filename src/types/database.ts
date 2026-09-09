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

export type ImportEntity = "ORDERS" | "PRODUCTS" | "EXPENSES"

export type ImportStatus =
  | "DRAFT"
  | "READY"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED"

/**
 * The lifecycle of a source-field mapping.
 *
 * Only `CONFIRMED` permits a source figure to become a BizMind figure, and the
 * database enforces that with a CHECK constraint rather than trusting code.
 * `UNKNOWN` is a real answer, not a failure: it records that a person looked
 * and does not know, which stops the same question being asked every import.
 */
export type MappingStatus =
  | "SUGGESTED"
  | "PENDING_CONFIRMATION"
  | "CONFIRMED"
  | "REJECTED"
  | "UNKNOWN"

/** Whether a source may supply a metric, or BizMind alone calculates it. */
export type MetricOrigin = "sourced" | "computed"

export type MappingConfidence = "high" | "medium" | "low"

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
            /** NULL means the source did not record it. Zero means recorded as zero. */
            subtotal: Numeric | null
            discount_total: Numeric | null
            tax_total: Numeric | null
            shipping_total: Numeric | null
            /**
             * Marketplace commission, processing, fulfilment. NULL means NOT
             * RECORDED, which is a different fact from a fee of zero -- profit
             * that ignores unrecorded fees is overstated.
             */
            fee_total: Numeric | null
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
          /** NULL means not recorded by the source. */
          unit_price: Numeric | null
          /**
           * Historical cost snapshot: what one unit cost AT THE TIME OF THIS
           * SALE. Never populated from the current product catalogue — see
           * migration 0005. Null means the cost is genuinely unknown.
           */
          unit_cost: Numeric | null
          /**
           * True when this line has no recorded cost, so any margin including
           * it is overstated. Generated from unit_cost; cannot be set.
           */
          cost_missing: boolean
          discount: Numeric | null
          tax: Numeric | null
          line_total: Numeric | null
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

      /* ---- Import pipeline (migration 0004) ---------------------------- */

      import_batches: {
        Row: Tenanted & {
          created_by: string | null
          entity: ImportEntity
          status: ImportStatus
          source: ChannelType | null
          channel_id: string | null
          file_name: string
          file_type: "csv" | "xlsx"
          file_size_bytes: number
          /** Detected column headings. */
          columns: Json
          /** The parsed file, kept so mapping can be re-run and audited. */
          raw_rows: Json
          row_count: number
          mapping: Json | null
          options: Json | null
          rows_valid: number | null
          rows_failed: number | null
          created_count: number | null
          updated_count: number | null
          error: string | null
          updated_at: string
          committed_at: string | null
        }
        Insert: {
          business_id: string
          created_by?: string | null
          entity: ImportEntity
          status?: ImportStatus
          source?: ChannelType | null
          channel_id?: string | null
          file_name: string
          file_type: "csv" | "xlsx"
          file_size_bytes: number
          columns?: Json
          raw_rows?: Json
          row_count?: number
          mapping?: Json | null
          options?: Json | null
        }
        Update: {
          status?: ImportStatus
          source?: ChannelType | null
          channel_id?: string | null
          mapping?: Json | null
          options?: Json | null
          rows_valid?: number | null
          rows_failed?: number | null
          created_count?: number | null
          updated_count?: number | null
          error?: string | null
          committed_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "import_batches_channel_id_fkey"
            columns: ["channel_id"]
            isOneToOne: false
            referencedRelation: "channels"
            referencedColumns: ["id"]
          },
        ]
      }

      import_issues: {
        Row: Tenanted & {
          batch_id: string
          row_number: number
          severity: "ERROR" | "WARNING"
          field: string | null
          message: string
          raw_value: string | null
        }
        Insert: {
          business_id: string
          batch_id: string
          row_number: number
          severity: "ERROR" | "WARNING"
          field?: string | null
          message: string
          raw_value?: string | null
        }
        Update: never
        Relationships: [
          {
            foreignKeyName: "import_issues_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "import_batches"
            referencedColumns: ["id"]
          },
        ]
      }

      canonical_metrics: {
        /**
         * BizMind's own vocabulary. Shared by every tenant, so no business_id.
         * Definitions live in `src/services/metrics/canonical.ts`; this table
         * exists so a constraint can act on the vocabulary.
         */
        Row: {
          key: string
          origin: MetricOrigin
          created_at: string
        }
        /** Written by migrations only. No tenant may add a metric. */
        Insert: never
        Update: never
        Relationships: []
      }

      source_records: {
        Row: Tenanted & {
          import_batch_id: string | null
          source: ChannelType
          record_type: string
          external_id: string | null
          period_start: string | null
          period_end: string | null
          /** The record as supplied. A blank cell is null, NEVER 0. */
          figures: Json
          /** Which columns were blank, so blank stays distinct from zero. */
          blank_fields: string[]
          /** Reconciliations run at import. A failure is recorded, not fixed. */
          checks: Json
          updated_at: string
        }
        Insert: {
          business_id: string
          import_batch_id?: string | null
          source: ChannelType
          record_type: string
          external_id?: string | null
          period_start?: string | null
          period_end?: string | null
          figures?: Json
          blank_fields?: string[]
          checks?: Json
        }
        Update: {
          figures?: Json
          blank_fields?: string[]
          checks?: Json
        }
        Relationships: [
          {
            foreignKeyName: "source_records_import_batch_id_fkey"
            columns: ["import_batch_id"]
            isOneToOne: false
            referencedRelation: "import_batches"
            referencedColumns: ["id"]
          },
        ]
      }

      source_field_semantics: {
        Row: Tenanted & {
          source: ChannelType
          entity: ImportEntity | null
          field_key: string
          source_label: string
          status: MappingStatus
          /**
           * What a name-matching rule SUSPECTS. Never read by analytics.
           * Kept in its own column so it cannot be promoted by accident.
           */
          candidate_metric: string | null
          candidate_confidence: MappingConfidence | null
          candidate_reason: string | null
          ambiguity_warning: string | null
          /**
           * What BizMind is PERMITTED to treat this field as. Null unless a
           * person confirmed it. Constrained to sourced canonical metrics.
           */
          maps_to: string | null
          note: string | null
          resolution_hint: string | null
          confirmed_by: string | null
          confirmed_at: string | null
          updated_at: string
        }
        /**
         * A SUGGESTION is writable directly, because it is not a claim about
         * money. A confirmation is, so it goes through
         * `confirm_source_field_semantics()`, which checks the caller's role
         * and writes an audit entry. The CHECK constraints refuse an
         * unconfirmed mapping either way.
         */
        Insert: {
          business_id: string
          source: ChannelType
          entity?: ImportEntity | null
          field_key: string
          source_label: string
          status?: MappingStatus
          candidate_metric?: string | null
          candidate_confidence?: MappingConfidence | null
          candidate_reason?: string | null
          ambiguity_warning?: string | null
          note?: string | null
          resolution_hint?: string | null
        }
        Update: {
          candidate_metric?: string | null
          candidate_confidence?: MappingConfidence | null
          candidate_reason?: string | null
          ambiguity_warning?: string | null
          note?: string | null
          resolution_hint?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "semantics_maps_to_sourced_metric"
            columns: ["maps_to", "sourced_origin"]
            isOneToOne: false
            referencedRelation: "canonical_metrics"
            referencedColumns: ["key", "origin"]
          },
        ]
      }

      source_mapping_profiles: {
        Row: Tenanted & {
          source: ChannelType
          entity: ImportEntity
          name: string
          /** The file's column set, normalised. Recognises the same export. */
          signature: string
          columns: string[]
          created_by: string | null
          updated_at: string
        }
        Insert: {
          business_id: string
          source: ChannelType
          entity: ImportEntity
          name: string
          signature: string
          columns?: string[]
        }
        Update: {
          name?: string
          columns?: string[]
        }
        Relationships: []
      }

      source_mapping_profile_fields: {
        /**
         * Which source fields a profile covers. Holds no metric of its own:
         * meaning is reached through `semantics_id`, behind the gate.
         */
        Row: Tenanted & {
          profile_id: string
          semantics_id: string
          position: number
        }
        Insert: {
          business_id: string
          profile_id: string
          semantics_id: string
          position?: number
        }
        Update: never
        Relationships: [
          {
            foreignKeyName: "source_mapping_profile_fields_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "source_mapping_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "source_mapping_profile_fields_semantics_id_fkey"
            columns: ["semantics_id"]
            isOneToOne: false
            referencedRelation: "source_field_semantics"
            referencedColumns: ["id"]
          },
        ]
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

      /* ---- Import pipeline (migration 0004) ----------------------------
       * Each applies a whole file in ONE transaction. business_id is read
       * from the batch row, never from arguments, so a caller cannot import
       * into a business they do not belong to. */

      import_apply_orders: {
        Args: { p_batch_id: string; p_rows: Json }
        Returns: Json
      }
      import_apply_products: {
        Args: { p_batch_id: string; p_rows: Json }
        Returns: Json
      }
      import_apply_expenses: {
        Args: { p_batch_id: string; p_rows: Json }
        Returns: Json
      }

      /* ---- Analytics engine (migration 0007) ---------------------------
       * The authoritative calculation layer. Every money field comes back as
       * a string; every ratio is nullable because a zero denominator yields
       * NULL rather than 0 or infinity. */

      analytics_financials: {
        Args: { p_business_id: string; p_from: string; p_to: string }
        Returns: {
          revenue: Numeric
          cogs: Numeric
          fees: Numeric
          gross_profit: Numeric
          gross_margin: Numeric | null
          expenses: Numeric
          net_profit: Numeric
          net_margin: Numeric | null
          orders_count: number
          units_sold: Numeric
          avg_order_value: Numeric | null
          customers_count: number
          refunds: Numeric
          returns_count: number
          cancelled_orders: number
          items_total: number
          items_with_cost: number
          cost_coverage: Numeric | null
          orders_zero_fees: number
          orders_without_channel: number
          line_revenue: Numeric
          /** Orders whose fees the source never recorded. */
          orders_fees_unknown: number
          /** Share of orders with a known fee. Below 100 means profit is overstated. */
          fee_coverage: Numeric | null
        }[]
      }

      analytics_compare: {
        Args: {
          p_business_id: string
          p_from: string
          p_to: string
          p_prev_from: string
          p_prev_to: string
        }
        Returns: {
          metric: string
          current_value: Numeric | null
          previous_value: Numeric | null
          absolute_change: Numeric | null
          percent_change: Numeric | null
          direction: "up" | "down" | "flat" | "unknown"
        }[]
      }

      analytics_channels: {
        Args: { p_business_id: string; p_from: string; p_to: string }
        Returns: {
          channel_id: string | null
          channel_name: string
          channel_type: ChannelType
          revenue: Numeric
          cogs: Numeric
          fees: Numeric
          gross_profit: Numeric
          gross_margin: Numeric | null
          orders_count: number
          units_sold: Numeric
          avg_order_value: Numeric | null
          items_total: number
          items_with_cost: number
          cost_coverage: Numeric | null
          orders_fees_unknown: number
          fee_coverage: Numeric | null
          /** Share of order lines with NO recorded cost. Computed in SQL. */
          cost_gap: Numeric | null
          /** Share of orders with NO recorded fee. Unknown, not zero. */
          fee_gap: Numeric | null
        }[]
      }

      analytics_products: {
        Args: { p_business_id: string; p_from: string; p_to: string; p_limit?: number }
        Returns: {
          sku: string
          product_name: string
          revenue: Numeric
          units_sold: Numeric
          cogs: Numeric
          fees_allocated: Numeric
          gross_profit: Numeric
          gross_margin: Numeric | null
          orders_count: number
          items_total: number
          items_with_cost: number
          cost_coverage: Numeric | null
        }[]
      }

      analytics_reconciliation: {
        Args: { p_business_id: string; p_from: string; p_to: string }
        Returns: {
          order_revenue: Numeric
          channel_revenue: Numeric
          channel_difference: Numeric
          line_revenue: Numeric
          order_line_gap: Numeric
          orders_without_lines: number
        }[]
      }

      analytics_health_inputs: {
        Args: {
          p_business_id: string
          p_from: string
          p_to: string
          p_prev_from: string
          p_prev_to: string
        }
        Returns: {
          revenue: Numeric
          revenue_previous: Numeric
          revenue_growth_pct: Numeric | null
          gross_margin: Numeric | null
          net_margin: Numeric | null
          cost_coverage: Numeric | null
          refund_rate: Numeric | null
          expense_ratio: Numeric | null
          orders_count: number
          customers_count: number
          repeat_customer_rate: Numeric | null
          cancelled_rate: Numeric | null
          orders_without_channel: number
          orders_zero_fees: number
          variants_tracked: number
          variants_out_of_stock: number
          variants_below_reorder: number
          paid_order_value: Numeric
          unpaid_order_value: Numeric
          payment_capture_rate: Numeric | null
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

      /* ---- Canonical field mapping (migration 0009) ---------------------
       * Suggesting is ordinary work. Confirming is a claim about money, so
       * it is restricted to an owner or admin and writes an audit entry. */

      suggest_source_field_semantics: {
        Args: {
          p_business_id: string
          p_source: ChannelType
          p_entity: ImportEntity
          p_field_key: string
          p_source_label: string
          p_candidate_metric?: string | null
          p_confidence?: MappingConfidence | null
          p_reason?: string | null
          p_ambiguity?: string | null
        }
        Returns: Database["public"]["Tables"]["source_field_semantics"]["Row"]
      }

      confirm_source_field_semantics: {
        Args: {
          p_business_id: string
          p_source: ChannelType
          p_field_key: string
          p_status: MappingStatus
          p_maps_to?: string | null
          p_note?: string | null
          p_source_label?: string | null
          p_entity?: ImportEntity | null
        }
        Returns: Database["public"]["Tables"]["source_field_semantics"]["Row"]
      }

      save_mapping_profile: {
        Args: {
          p_business_id: string
          p_source: ChannelType
          p_entity: ImportEntity
          p_name: string
          p_signature: string
          p_columns: string[]
          p_field_keys: string[]
        }
        Returns: Database["public"]["Tables"]["source_mapping_profiles"]["Row"]
      }

      resolve_mapping_profile: {
        Args: {
          p_business_id: string
          p_source: ChannelType
          p_entity: ImportEntity
          p_signature: string
        }
        Returns: {
          profile_id: string
          profile_name: string
          field_key: string
          source_label: string
          status: MappingStatus
          maps_to: string | null
          candidate_metric: string | null
          confidence: MappingConfidence | null
          confirmed_at: string | null
          /** The only condition under which a source figure may be used. */
          usable: boolean
        }[]
      }

      mapping_lineage: {
        Args: { p_business_id: string; p_metric?: string | null }
        Returns: {
          canonical_metric: string | null
          source: ChannelType
          source_label: string
          field_key: string
          status: MappingStatus
          confirmed_by: string | null
          confirmed_by_name: string | null
          confirmed_at: string | null
          note: string | null
          candidate_metric: string | null
          candidate_confidence: MappingConfidence | null
          records_preserved: number
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
      import_entity: ImportEntity
      import_status: ImportStatus
      mapping_status: MappingStatus
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
export type ImportBatch = T["import_batches"]["Row"]
export type ImportIssue = T["import_issues"]["Row"]
export type CanonicalMetricRow = T["canonical_metrics"]["Row"]
export type SourceRecord = T["source_records"]["Row"]
export type SourceFieldSemantics = T["source_field_semantics"]["Row"]
export type SourceMappingProfile = T["source_mapping_profiles"]["Row"]
export type SourceMappingProfileField = T["source_mapping_profile_fields"]["Row"]

/** A business plus the calling user's role in it. */
export type BusinessWithRole = Business & { role: BusinessRole }
