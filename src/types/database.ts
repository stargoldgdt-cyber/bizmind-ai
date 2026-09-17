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
 * Money is `numeric(20,4)` in PostgreSQL and reaches the application as an
 * EXACT DECIMAL STRING, because migration 0011 casts it to `text` in SQL while
 * it is still exact. `{"revenue":"9550.5000"}` — quoted, full scale.
 *
 * Before 0011 these arrived as unquoted JSON numbers and `JSON.parse` narrowed
 * them to doubles, so the `string` declaration here was simply false.
 *
 * The type does not prevent arithmetic — `a + b` on two strings compiles and
 * concatenates. `scripts/verify-money-guard.ts` is what prevents it, by
 * scanning the source. Counts stay `number`: they are exact integers well
 * below 2^53, and casting them would make the types lie the other way.
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

/** LEDGER (migration 0029): a marketplace file written to the financial ledger. */
export type ImportEntity = "ORDERS" | "PRODUCTS" | "EXPENSES" | "LEDGER"

/** Ledger sides and attribution (migration 0030). */
export type LedgerSideDb = "PNL" | "CASH" | "TAX" | "MEMO"
export type LedgerAttributionDb = "ORDER_LINE" | "ORDER" | "MARKETPLACE"

/** The classification model (migration 0032, src/services/classification/model.ts). */
export type FinancialTypeDb = "REVENUE" | "EXPENSE" | "TAX" | "CASH" | "MEMO"
export type PnlTreatmentDb =
  | "INCREASE_REVENUE"
  | "DECREASE_REVENUE"
  | "INCREASE_EXPENSE"
  | "NO_PNL_IMPACT"
  | "CONDITIONAL"
export type ClassificationStatusDb = "CLASSIFIED" | "UNDER_REVIEW" | "UNKNOWN"
export type FigureStatusDb = "FINAL" | "INCOMPLETE"
export type InputVatTreatmentDb = "UNKNOWN" | "RECOVERABLE" | "NON_RECOVERABLE"

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

/* ---- Integrations (migration 0012) --------------------------------------- */

export type IntegrationProvider = "FIXTURE" | "WOOCOMMERCE" | "SHOPIFY" | "GOOGLE_SHEETS"

export type IntegrationStatus =
  | "CONNECTED"
  | "ERROR"
  | "DISCONNECTED"
  /** The owner switched sync off (migration 0019). Only the owner sets it. */
  | "PAUSED"
  /** Google access expired or was revoked. Nothing syncs until reconnected. */
  | "REAUTH_REQUIRED"
  /** A mapped column was renamed or removed. Writing stops rather than guessing. */
  | "MAPPING_REVIEW_REQUIRED"

export type SyncMode = "INITIAL" | "INCREMENTAL"

export type SyncStatus =
  | "QUEUED"
  | "RUNNING"
  | "SUCCEEDED"
  /** Some records applied, some rejected. The cursor still advanced. */
  | "PARTIAL"
  | "RETRYING"
  | "FAILED"
  /** Out of attempts. Needs a person. */
  | "DEAD_LETTER"

export type WebhookEventStatus =
  | "RECEIVED"
  | "PROCESSING"
  | "PROCESSED"
  | "DUPLICATE"
  | "FAILED"
  | "DEAD_LETTER"
  | "REJECTED"

export type SyncResourceKey = "ORDERS" | "PRODUCTS" | "CUSTOMERS" | "INVENTORY" | "EXPENSES"

/** Why a sync ran (migration 0019). Shown in a sheet's sync history. */
export type SyncTrigger = "INITIAL" | "AUTOMATIC" | "MANUAL" | "RECONCILIATION"

/* ---- Automation (migration 0016) ----------------------------------------- */

/**
 * How a rule compares a metric to its threshold.
 *
 * `CHANGE_PCT_*` compare the period-on-period percentage change instead of the
 * value, so "revenue fell by more than 20%" is `CHANGE_PCT_LT` with a
 * threshold of `-20`.
 */
export type AutomationOperator =
  | "LT"
  | "LTE"
  | "GT"
  | "GTE"
  | "CHANGE_PCT_LT"
  | "CHANGE_PCT_GT"

export type AlertSeverity = "INFO" | "WARNING" | "CRITICAL"

export type AlertStatus = "OPEN" | "ACKNOWLEDGED" | "RESOLVED"

export type AutomationRunStatus =
  | "FIRED"
  | "NOT_MATCHED"
  /** Deliberately not judged. `skipped_reason` says why. */
  | "SKIPPED"
  | "FAILED"

/**
 * Why an evaluation declined to reach a verdict.
 *
 * These exist so "why didn't I get an alert?" has an answer. A silent
 * non-event is indistinguishable from a broken rule, and an owner who cannot
 * tell them apart stops relying on alerts altogether.
 */
export type AutomationSkipReason =
  /** The rule fired recently and is inside its cooldown window. */
  | "COOLDOWN"
  /** The figure could not be measured — no orders, or a ratio with no base. */
  | "METRIC_NULL"
  /** Cost or fee coverage is short, so a profit figure would be overstated. */
  | "INCOMPLETE_DATA"
  | "DISABLED"
  /** The metric exists in the vocabulary but analytics does not publish it. */
  | "NO_ANALYTICS_KEY"
  /** `analytics_compare()` produces no period-on-period change for it. */
  | "NO_COMPARISON"

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
/**
 * An exact decimal, as text. Migration 0011 casts every money and ratio column
 * to `text` in SQL, so this declaration matches the runtime value.
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

      /* ---- Marketplace ledger foundation (migration 0030) ---------------- *
       * Read-only to signed-in users. The only writers are the SECURITY DEFINER
       * functions under Functions; a trigger refuses even the service role.
       * bigint ids arrive as JSON numbers. Money on these rows is numeric --
       * read money through the ledger_* views, which return exact text. */

      marketplaces: {
        Row: {
          code: string
          name: string
          adapter_status: "AVAILABLE" | "SAMPLES_REQUIRED" | "CONTRACT_ONLY"
          created_at: string
        }
        Insert: never
        Update: never
        Relationships: []
      }

      marketplace_accounts: {
        Row: {
          id: string
          business_id: string
          marketplace_code: string
          label: string
          country: string
          currency: string
          external_seller_ref: string | null
          status: "ACTIVE" | "ARCHIVED"
          created_by: string | null
          created_at: string
          updated_at: string
        }
        Insert: never
        Update: never
        Relationships: []
      }

      tax_profiles: {
        Row: {
          id: string
          business_id: string
          marketplace_account_id: string
          vat_registration: "UNKNOWN" | "REGISTERED" | "NOT_REGISTERED"
          /** Only UNCONFIGURED exists until an accountant confirms a treatment. */
          treatment: "UNCONFIGURED"
          /** How VAT on marketplace fees counts in profit (B1, migration 0032). */
          input_vat_treatment: InputVatTreatmentDb
          note: string | null
          updated_by: string | null
          created_at: string
          updated_at: string
        }
        Insert: never
        Update: never
        Relationships: []
      }

      source_rows: {
        Row: {
          id: number
          business_id: string
          source_file_id: string
          row_number: number
          /** The row as read: text or null (blank). Never customer data. */
          raw: Record<string, string | null>
          row_hash: string
          created_at: string
        }
        Insert: never
        Update: never
        Relationships: []
      }

      ledger_mapping_rules: {
        Row: {
          id: string
          scope: "GLOBAL" | "BUSINESS"
          business_id: string | null
          marketplace_code: string
          format_id: string
          match_key: string
          match: Json
          side: LedgerSideDb
          category: string
          subcategory: string | null
          sign_rule: "AS_REPORTED" | "NEGATE"
          quantity_rule: "NONE" | "REPORTED" | "COUNT_LINE"
          attribution: LedgerAttributionDb
          confidence: "SAMPLE_VERIFIED" | "SELLER_ANALYSIS" | "DOCUMENTED" | "PROVISIONAL"
          evidence: string
          version: number
          supersedes_id: string | null
          status: "ACTIVE" | "RETIRED"
          created_at: string
        }
        Insert: never
        Update: never
        Relationships: []
      }

      /* ---- Classification (migration 0032) ------------------------------ */

      classification_categories: {
        Row: {
          code: string
          financial_type: FinancialTypeDb
          label: string
          default_treatment: PnlTreatmentDb
          metric_group: string
          sort_order: number
        }
        Insert: never
        Update: never
        Relationships: []
      }

      classification_rules: {
        Row: {
          id: string
          scope: "GLOBAL" | "BUSINESS"
          business_id: string | null
          marketplace_code: string
          format_id: string
          match_key: string
          category: string
          subcategory: string
          confidence: "HIGH" | "MEDIUM"
          evidence: string
          version: number
          supersedes_id: string | null
          status: "ACTIVE" | "RETIRED"
          /** Migration 0034: the amount has VAT inside it the marketplace does not state. */
          amount_includes_vat: boolean
          /** Migration 0034: the line takes stated VAT back out (a VAT invoice). */
          separates_included_vat: boolean
          created_at: string
        }
        Insert: never
        Update: never
        Relationships: []
      }

      settlements: {
        Row: {
          id: string
          business_id: string
          marketplace_account_id: string
          source_file_id: string
          source_row_id: number
          external_settlement_id: string
          period_start: string | null
          period_end: string | null
          reported_total: Numeric | null
          reported_deposit_date: string | null
          currency: string
          created_at: string
        }
        Insert: never
        Update: never
        Relationships: []
      }

      payouts: {
        Row: {
          id: string
          business_id: string
          marketplace_account_id: string
          origin: "SOURCE_FILE" | "MANUAL"
          source_file_id: string | null
          source_row_id: number | null
          settlement_id: string | null
          external_ref: string | null
          amount: Numeric
          currency: string
          paid_at: string | null
          created_by: string | null
          voided_at: string | null
          void_reason: string | null
          created_at: string
        }
        Insert: never
        Update: never
        Relationships: []
      }

      financial_transactions: {
        Row: {
          id: number
          business_id: string
          marketplace_account_id: string
          source_file_id: string
          source_row_id: number
          line_index: number
          mapping_rule_id: string | null
          side: LedgerSideDb | null
          category: string
          subcategory: string | null
          source_type: string | null
          source_subtype: string | null
          source_description: string | null
          amount: Numeric
          currency: string
          posted_at: string
          order_ref: string | null
          order_line_ref: string | null
          raw_sku: string | null
          quantity: Numeric | null
          quantity_basis: "REPORTED" | "DERIVED_LINE_COUNT" | null
          attribution: LedgerAttributionDb
          settlement_id: string | null
          payout_id: string | null
          created_at: string
        }
        Insert: never
        Update: never
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
          /** "api" (migration 0018) for a batch a sync wrote. */
          /** "txt" (migration 0031): a marketplace settlement report. */
          file_type: "csv" | "xlsx" | "api" | "txt"
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
          /** Migration 0020. Set when a sync wrote this batch; null for an upload. */
          integration_account_id: string | null
          sync_run_id: string | null
          /** Migration 0030. LEGACY for every import before the ledger. */
          dataset: "LEGACY" | "LEDGER"
          source_kind: "UPLOAD" | "GOOGLE_SHEETS" | "API" | "NATIVE" | null
          marketplace_account_id: string | null
          format_id: string | null
          adapter_version: string | null
          /** Fingerprint of the uploaded file; the bytes are not kept (decision B6). */
          file_sha256: string | null
          /** Columns removed before storage: outside the format, or customer data. */
          stripped_columns: string[]
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
          /**
           * The column this metric occupies in the analytics functions —
           * `marketplace_fees` lives in a column called `fees`. Copied from
           * `analyticsKey` in canonical.ts by migration 0016 so an automation
           * rule can be resolved in SQL without asking the application.
           *
           * NULL means analytics does not publish it, so no rule can fire on
           * it — which the evaluator records rather than treating as false.
           */
          analytics_key: string | null
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

      integrations: {
        Row: Tenanted & {
          provider: IntegrationProvider
          status: IntegrationStatus
          created_by: string | null
          updated_at: string
          /** Migration 0022. Who connected Google for this business, and when. */
          authorized_by: string | null
          authorized_at: string | null
        }
        Insert: {
          business_id: string
          provider: IntegrationProvider
          status?: IntegrationStatus
        }
        /**
         * `credentials_encrypted` (migration 0022) can be SET by the one
         * confined server-side writer but is never selectable -- the same
         * asymmetry as integration_accounts.
         */
        Update: { status?: IntegrationStatus; credentials_encrypted?: string | null }
        Relationships: []
      }

      integration_accounts: {
        /**
         * One connected store.
         *
         * `credentials_encrypted` and `webhook_secret_encrypted` are absent
         * from this Row on purpose: migration 0012 REVOKES select on those
         * columns from `authenticated`, so a client-side read cannot return
         * them. They are reachable only through the trusted server-side path.
         */
        Row: Tenanted & {
          integration_id: string
          /**
           * Copied from the parent integration and held there by a composite
           * foreign key. Exists so store uniqueness can be enforced ACROSS
           * businesses -- keying it on integration_id made it per-business,
           * which is not what it claimed to do.
           */
          provider: IntegrationProvider
          external_account_id: string
          display_name: string | null
          status: IntegrationStatus
          channel_id: string | null
          metadata: Json
          last_successful_sync_at: string | null
          last_attempted_sync_at: string | null
          last_error: string | null
          connected_by: string | null
          connected_at: string
          revoked_at: string | null
          updated_at: string
        }
        /** Written through `integration_account_connect()`, never directly. */
        Insert: never
        /**
         * The credential columns appear here but NOT in Row, and that
         * asymmetry is the point: migration 0012 revokes SELECT on them from
         * `authenticated`, so nothing that reads a row may see them, while the
         * one confined server-side writer may set them.
         */
        Update: {
          display_name?: string | null
          metadata?: Json
          credentials_encrypted?: string | null
          webhook_secret_encrypted?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "integration_accounts_integration_id_fkey"
            columns: ["integration_id"]
            isOneToOne: false
            referencedRelation: "integrations"
            referencedColumns: ["id"]
          },
        ]
      }

      sync_jobs: {
        Row: Tenanted & {
          integration_account_id: string
          resource: SyncResourceKey
          mode: SyncMode
          status: SyncStatus
          cursor: string | null
          priority: number
          next_run_at: string
          attempts: number
          max_attempts: number
          locked_at: string | null
          locked_until: string | null
          locked_by: string | null
          last_error: string | null
          updated_at: string
          /** Migration 0020. Why the next run will happen. */
          next_trigger: SyncTrigger | null
          rerun_requested: boolean
        }
        /** Written through `sync_enqueue()`. */
        Insert: never
        Update: never
        Relationships: []
      }

      sync_runs: {
        Row: {
          id: string
          business_id: string
          job_id: string
          attempt: number
          started_at: string
          completed_at: string | null
          status: SyncStatus
          records_fetched: number
          records_applied: number
          records_skipped: number
          cursor_before: string | null
          cursor_after: string | null
          error_summary: string | null
          /** Migration 0020. Why this run happened, and what it wrote. */
          trigger: SyncTrigger | null
          rows_inserted: number | null
          rows_updated: number | null
          rows_unchanged: number | null
          rows_rejected: number | null
        }
        Insert: never
        Update: never
        Relationships: []
      }

      /**
       * Migrations 0021 and 0023. One fingerprint per business record per
       * connection. Members may read it; only the worker writes it.
       */
      integration_record_state: {
        Row: {
          id: string
          business_id: string
          integration_account_id: string
          entity: string
          business_key: string
          content_hash: string
          last_outcome: "APPLIED" | "REJECTED"
          locator: Json
          present: boolean
          first_seen_at: string
          last_seen_at: string
          last_changed_at: string
          last_seen_run_id: string | null
          last_seen_pass: string | null
        }
        Insert: never
        Update: never
        Relationships: []
      }

      sync_logs: {
        Row: Tenanted & {
          run_id: string | null
          level: "DEBUG" | "INFO" | "WARN" | "ERROR"
          provider: IntegrationProvider | null
          operation: string
          duration_ms: number | null
          context: Json
          error: string | null
        }
        Insert: {
          business_id: string
          run_id?: string | null
          level: "DEBUG" | "INFO" | "WARN" | "ERROR"
          provider?: IntegrationProvider | null
          operation: string
          duration_ms?: number | null
          context?: Json
          error?: string | null
        }
        Update: never
        Relationships: []
      }

      webhook_events: {
        Row: {
          id: string
          business_id: string
          integration_account_id: string
          provider: IntegrationProvider
          event_type: string
          external_event_id: string
          /** The unique constraint that makes a redelivery free. */
          idempotency_key: string
          raw_body: string
          signature_valid: boolean
          status: WebhookEventStatus
          received_at: string
          processed_at: string | null
          attempts: number
          max_attempts: number
          next_run_at: string | null
          last_error: string | null
        }
        /** Written only by `webhook_event_ingest()`, on the trusted path. */
        Insert: never
        Update: never
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

      /* ---- Automation (migration 0016) --------------------------------- */

      automation_rules: {
        /**
         * A standing instruction: watch this metric, tell me when it crosses
         * this line.
         *
         * `threshold` is `numeric` and therefore a string, like every other
         * figure here. It is never compared in TypeScript — the comparison
         * happens inside `automation_evaluate_rule()`, so an alert can never
         * be based on a number that differs from the dashboard's.
         */
        Row: Tenanted & {
          name: string
          description: string | null
          enabled: boolean
          metric: string
          operator: AutomationOperator
          threshold: Numeric
          period_days: number
          severity: AlertSeverity
          cooldown_hours: number
          evaluate_every_minutes: number
          next_run_at: string
          suppress_when_incomplete: boolean
          /** Always true in V1: nothing executes, so nothing acts unapproved. */
          requires_approval: boolean
          created_by: string | null
          updated_at: string
        }
        Insert: {
          business_id: string
          name: string
          description?: string | null
          enabled?: boolean
          metric: string
          operator: AutomationOperator
          threshold: Numeric
          period_days?: number
          severity?: AlertSeverity
          cooldown_hours?: number
          evaluate_every_minutes?: number
          suppress_when_incomplete?: boolean
          created_by?: string | null
        }
        Update: {
          name?: string
          description?: string | null
          enabled?: boolean
          metric?: string
          operator?: AutomationOperator
          threshold?: Numeric
          period_days?: number
          severity?: AlertSeverity
          cooldown_hours?: number
          evaluate_every_minutes?: number
          suppress_when_incomplete?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "automation_rules_metric_fkey"
            columns: ["metric"]
            isOneToOne: false
            referencedRelation: "canonical_metrics"
            referencedColumns: ["key"]
          },
        ]
      }

      automation_runs: {
        /**
         * One evaluation, whatever came of it.
         *
         * The rows that did NOT fire are the valuable ones. A table of alerts
         * records what happened; only this records what didn't, and why.
         */
        Row: Tenanted & {
          rule_id: string
          evaluated_at: string
          status: AutomationRunStatus
          metric_value: Numeric | null
          /** Null on a FAILED run that never got far enough to know it. */
          threshold: Numeric | null
          skipped_reason: AutomationSkipReason | null
          alert_id: string | null
          error: string | null
        }
        /** Written by `automation_evaluate_rule()`, never by hand. */
        Insert: never
        Update: never
        Relationships: [
          {
            foreignKeyName: "automation_runs_rule_id_fkey"
            columns: ["rule_id"]
            isOneToOne: false
            referencedRelation: "automation_rules"
            referencedColumns: ["id"]
          },
        ]
      }

      alerts: {
        /**
         * The metric, value, threshold and period are COPIED here rather than
         * joined from the rule. A rule can be edited afterwards, and an alert
         * that re-read its rule would quietly rewrite its own history.
         */
        Row: Tenanted & {
          rule_id: string | null
          run_id: string | null
          severity: AlertSeverity
          title: string
          body: string
          metric: string
          metric_value: Numeric
          threshold: Numeric
          period_days: number
          /**
           * How the comparison was made (migration 0017).
           *
           * Without this, a CHANGE_PCT alert on revenue and a value alert on
           * revenue are indistinguishable on the row — one stores a
           * percentage and the other stores money, and both say
           * `metric: "revenue"`. The display layer needs it to know whether
           * to print a currency symbol.
           */
          operator: AutomationOperator
          status: AlertStatus
          acknowledged_by: string | null
          acknowledged_at: string | null
        }
        /** Raised by `automation_evaluate_rule()` alone. */
        Insert: never
        /** Acknowledged through `alert_acknowledge()`, which stamps the actor. */
        Update: { status?: AlertStatus }
        Relationships: [
          {
            foreignKeyName: "alerts_rule_id_fkey"
            columns: ["rule_id"]
            isOneToOne: false
            referencedRelation: "automation_rules"
            referencedColumns: ["id"]
          },
        ]
      }
    }

    Views: {
      /* ---- The counting scope (migration 0030) ---------------------------
       * Active source files only; money as exact text. */

      ledger_lines: {
        Row: {
          id: number
          business_id: string
          marketplace_account_id: string
          marketplace_code: string
          source_file_id: string
          source_row_id: number
          line_index: number
          mapping_rule_id: string | null
          side: LedgerSideDb | null
          category: string
          subcategory: string | null
          source_type: string | null
          source_subtype: string | null
          source_description: string | null
          amount: string
          currency: string
          posted_at: string
          order_ref: string | null
          order_line_ref: string | null
          raw_sku: string | null
          quantity: string | null
          quantity_basis: "REPORTED" | "DERIVED_LINE_COUNT" | null
          attribution: LedgerAttributionDb
          settlement_id: string | null
          payout_id: string | null
          created_at: string
        }
        Relationships: []
      }

      ledger_settlements: {
        Row: {
          id: string
          business_id: string
          marketplace_account_id: string
          source_file_id: string
          source_row_id: number
          external_settlement_id: string
          period_start: string | null
          period_end: string | null
          reported_total: string | null
          reported_deposit_date: string | null
          currency: string
          created_at: string
        }
        Relationships: []
      }

      ledger_payouts: {
        Row: {
          id: string
          business_id: string
          marketplace_account_id: string
          origin: "SOURCE_FILE" | "MANUAL"
          source_file_id: string | null
          source_row_id: number | null
          settlement_id: string | null
          external_ref: string | null
          amount: string
          currency: string
          paid_at: string | null
          created_at: string
        }
        Relationships: []
      }

      /* Every counting line classified through the rules active now (0032). */
      ledger_classified_lines: {
        Row: {
          id: number
          business_id: string
          marketplace_account_id: string
          marketplace_code: string
          account_label: string
          source_file_id: string
          format_id: string | null
          source_row_id: number
          line_index: number
          match_key: string
          source_type: string | null
          source_subtype: string | null
          source_description: string | null
          amount: string
          currency: string
          posted_at: string
          order_ref: string | null
          raw_sku: string | null
          import_side: LedgerSideDb | null
          import_category: string
          rule_id: string | null
          rule_scope: "GLOBAL" | "BUSINESS" | null
          rule_confidence: "HIGH" | "MEDIUM" | null
          rule_version: number | null
          financial_type: FinancialTypeDb | null
          category: string | null
          category_label: string | null
          subcategory: string | null
          metric_group: string | null
          default_treatment: PnlTreatmentDb | null
          pnl_treatment: PnlTreatmentDb | null
          classification_status: ClassificationStatusDb
          rule_includes_vat: boolean
          rule_separates_vat: boolean
        }
        Relationships: []
      }
    }

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

      /* ---- Data sources and withdrawal (migration 0027) -----------------
       * The row shapes live in `src/features/imports/queries.ts`, beside the
       * code that reads them. */

      import_batch_overview: {
        Args: { p_limit?: number; p_offset?: number }
        Returns: Record<string, unknown>[]
      }

      import_batch_withdrawal_preview: {
        Args: { p_batch_id: string }
        Returns: Record<string, unknown>[]
      }

      /* ---- Marketplace ledger foundation (migration 0030) ---------------- */

      marketplace_account_create: {
        Args: {
          p_business_id: string
          p_marketplace_code: string
          p_label: string
          p_country: string
          p_currency: string
          p_external_seller_ref?: string | null
        }
        Returns: string
      }

      marketplace_account_update: {
        Args: {
          p_account_id: string
          p_label?: string | null
          p_external_seller_ref?: string | null
          p_currency?: string | null
          p_status?: "ACTIVE" | "ARCHIVED" | null
        }
        Returns: undefined
      }

      tax_profile_update: {
        Args: {
          p_account_id: string
          p_vat_registration: "UNKNOWN" | "REGISTERED" | "NOT_REGISTERED"
          p_note?: string | null
        }
        Returns: undefined
      }

      /* ---- Classification and the P&L engine (migration 0032) ----------- */

      tax_profile_set_input_vat: {
        Args: { p_account_id: string; p_treatment: InputVatTreatmentDb }
        Returns: undefined
      }

      pnl_summary: {
        Args: {
          p_from: string
          p_to: string
          p_account_id?: string | null
          /** Migration 0034. */
          p_business_id?: string | null
          /** Migration 0034: one row per currency instead of per account. */
          p_combine_by_currency?: boolean
        }
        Returns: {
          /** NULL on a combined (per-currency) row. */
          marketplace_account_id: string | null
          account_label: string
          marketplace_code: string
          currency: string
          period_from: string
          period_to: string
          gross_sales: string
          sales_refunds: string
          seller_discounts: string
          net_sales: string
          other_income: string
          marketplace_fees: string
          fulfillment: string
          advertising: string
          other_marketplace_costs: string
          non_recoverable_vat: string
          /** NULL unless contribution_status is FINAL. */
          contribution: string | null
          contribution_status: FigureStatusDb
          /** Informational only: never label it as the final contribution. */
          contribution_before_open_items: string
          figures_status: FigureStatusDb
          input_vat_recoverable: string
          input_vat_unresolved: string
          output_vat: string
          /** MIXED on a combined row whose accounts differ. */
          input_vat_treatment: InputVatTreatmentDb | "MIXED"
          lines: number
          unknown_lines: number
          unknown_amount: string
          review_lines: number
          review_amount: string
          conditional_lines: number
          row_errors: number
          incomplete_reasons: ("UNKNOWN_LINES" | "VAT_TREATMENT_UNKNOWN" | "FEE_VAT_NOT_SEPARATED" | "ROW_ERRORS")[]
          /** How many accounts the row covers (1 unless combined). */
          accounts: number
        }[]
      }

      pnl_breakdown: {
        Args: { p_from: string; p_to: string; p_account_id?: string | null }
        Returns: {
          marketplace_account_id: string
          account_label: string
          currency: string
          financial_type: FinancialTypeDb | null
          category: string | null
          category_label: string | null
          subcategory: string | null
          /** Set only for UNKNOWN lines, so the code can be named. */
          match_key: string | null
          classification_status: ClassificationStatusDb
          pnl_treatment: PnlTreatmentDb | null
          metric_group: string | null
          sort_order: number | null
          lines: number
          total: string
        }[]
      }

      ledger_data_quality: {
        Args: {
          p_from?: string | null
          p_to?: string | null
          p_account_id?: string | null
          /** Migration 0033: limit to one of the caller's businesses. */
          p_business_id?: string | null
        }
        Returns: {
          issue_kind:
            | "UNKNOWN_CODE"
            | "UNDER_REVIEW"
            | "VAT_TREATMENT_UNKNOWN"
            | "FEE_VAT_NOT_SEPARATED"
            | "ROW_ERRORS"
            | "SETTLEMENT_MISMATCH"
          severity: "WARNING" | "INFO"
          marketplace_account_id: string
          account_label: string
          marketplace_code: string
          currency: string
          format_id: string | null
          /** The marketplace code, or the settlement id for a mismatch. */
          reference: string | null
          category: string | null
          subcategory: string | null
          lines: number
          amount: string | null
          files: number
          detail: string
        }[]
      }

      /* ---- The ledger dashboard's readers (migration 0033) --------------- */

      pnl_periods: {
        Args: { p_business_id?: string | null }
        Returns: {
          marketplace_account_id: string
          account_label: string
          marketplace_code: string
          currency: string
          /** First day of the month, "YYYY-MM-01" (UTC). */
          month: string
          lines: number
        }[]
      }

      pnl_settlements: {
        Args: { p_from: string; p_to: string; p_account_id: string }
        Returns: {
          settlement_id: string
          source_file_id: string
          file_name: string
          external_settlement_id: string
          period_start: string | null
          period_end: string | null
          currency: string
          reported_total: string | null
          /** Every line of the settlement. */
          lines_total: string
          /** Only the lines posted in the period. */
          lines_in_period: string
          lines_in_period_count: number
          reconciles: boolean
          payout_amount: string | null
          payout_date: string | null
        }[]
      }

      classification_rule_impact: {
        Args: { p_business_id: string; p_marketplace_code: string; p_format_id: string; p_match_key: string }
        Returns: {
          marketplace_account_id: string
          account_label: string
          currency: string
          month: string
          lines: number
          amount: string
          classification_status: ClassificationStatusDb
          category: string | null
          subcategory: string | null
        }[]
      }

      classification_rule_classify: {
        Args: {
          p_business_id: string
          p_marketplace_code: string
          p_format_id: string
          p_match_key: string
          p_category: string
          p_subcategory: string
          p_note?: string | null
        }
        Returns: string
      }

      classification_rule_retire: {
        Args: { p_rule_id: string }
        Returns: undefined
      }

      ledger_apply_file: {
        Args: { p_file: Json }
        Returns: {
          source_file_id: string
          duplicate: boolean
          rows_written: number
          transactions_written: number
          settlements_written: number
          payouts_written: number
          issues_written: number
          unmapped_written: number
        }[]
      }

      ledger_file_summary: {
        Args: { p_source_file_id: string }
        Returns: {
          side: LedgerSideDb | null
          category: string
          subcategory: string | null
          lines: number
          total: string
          currency: string
        }[]
      }

      ledger_file_settlements: {
        Args: { p_source_file_id: string }
        Returns: {
          settlement_id: string
          external_settlement_id: string
          period_start: string | null
          period_end: string | null
          reported_total: string | null
          lines_total: string
          reconciles: boolean
          reported_deposit_date: string | null
          payout_amount: string | null
          currency: string
        }[]
      }

      ledger_file_withdraw: {
        Args: { p_source_file_id: string; p_reason?: string | null }
        Returns: {
          transactions_withdrawn: number
          settlements_withdrawn: number
          payouts_withdrawn: number
        }[]
      }

      ledger_file_restore: {
        Args: { p_source_file_id: string }
        Returns: {
          transactions_restored: number
          settlements_restored: number
          payouts_restored: number
        }[]
      }

      import_batch_withdraw: {
        Args: { p_batch_id: string; p_reason?: string | null }
        Returns: Record<string, unknown>[]
      }

      import_batch_restore: {
        Args: { p_batch_id: string }
        Returns: Record<string, unknown>[]
      }

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
        Args: { p_business_id: string; p_from: string; p_to: string; p_channel_id?: string | null; p_no_channel?: boolean }
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
          p_channel_id?: string | null
          p_no_channel?: boolean
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
        Args: { p_business_id: string; p_from: string; p_to: string; p_channel_id?: string | null; p_no_channel?: boolean }
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
          /** Refunds as a percentage of revenue. Computed in SQL. */
          refund_rate: Numeric | null
        }[]
      }

      analytics_products: {
        Args: {
          p_business_id: string
          p_from: string
          p_to: string
          p_limit?: number
          p_channel_id?: string | null
          p_no_channel?: boolean
        }
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
        Args: { p_business_id: string; p_from: string; p_to: string; p_channel_id?: string | null; p_no_channel?: boolean }
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

      /* ---- Integrations (migration 0012) -------------------------------
       * Only the AUTHENTICATED functions are typed here. The session-less
       * ones are granted to service_role alone and are reached exclusively
       * through `callTrusted()`, which is where their contract is stated. */

      integration_account_connect: {
        Args: {
          p_business_id: string
          p_provider: IntegrationProvider
          p_external_account_id: string
          p_display_name: string | null
          /** Null for a products or expenses sheet: not a sales channel (0020). */
          p_channel_type: ChannelType | null
          p_metadata?: Json
        }
        Returns: Database["public"]["Tables"]["integration_accounts"]["Row"]
      }

      integration_account_revoke: {
        Args: { p_account_id: string }
        Returns: Database["public"]["Tables"]["integration_accounts"]["Row"]
      }

      sync_enqueue: {
        Args: {
          p_account_id: string
          p_resource: SyncResourceKey
          p_mode?: SyncMode
          p_priority?: number
        }
        Returns: Database["public"]["Tables"]["sync_jobs"]["Row"]
      }

      webhook_event_replay: {
        Args: { p_event_id: string }
        Returns: Database["public"]["Tables"]["webhook_events"]["Row"]
      }

      /**
       * Migration 0022. Owner or admin. Creates or refreshes the business's
       * Google authorization row and reactivates any sheet that was waiting
       * for Google to be reconnected. Never returns the credential.
       */
      integration_google_authorize: {
        Args: { p_business_id: string }
        Returns: Database["public"]["Tables"]["integrations"]["Row"]
      }

      /** Migration 0020. Owner or admin. Resuming only turns PAUSED back into CONNECTED. */
      integration_account_pause: {
        Args: { p_account_id: string; p_paused: boolean }
        Returns: Database["public"]["Tables"]["integration_accounts"]["Row"]
      }

      /* ---- Channel comparison, drivers, data quality (0026) -------------
       * Their row shapes live in `src/services/analytics/types.ts`, where the
       * service reads them. Typing the columns twice is how two definitions of
       * one figure start to drift. */

      analytics_channel_compare: {
        Args: {
          p_business_id: string
          p_from: string
          p_to: string
          p_prev_from: string
          p_prev_to: string
        }
        Returns: Record<string, unknown>[]
      }

      analytics_change_drivers: {
        Args: {
          p_business_id: string
          p_from: string
          p_to: string
          p_prev_from: string
          p_prev_to: string
          p_limit?: number
          p_channel_id?: string | null
          p_no_channel?: boolean
        }
        Returns: Record<string, unknown>[]
      }

      analytics_data_quality: {
        Args: {
          p_business_id: string
          p_from: string
          p_to: string
          p_channel_id?: string | null
          p_no_channel?: boolean
        }
        Returns: Record<string, unknown>[]
      }

      analytics_quality_orders: {
        Args: {
          p_business_id: string
          p_from: string
          p_to: string
          p_issue: string
          p_limit?: number
          p_offset?: number
          p_channel_id?: string | null
          p_no_channel?: boolean
        }
        Returns: Record<string, unknown>[]
      }

      /* ---- Automation (migration 0016) ---------------------------------
       * `automation_claim_due` is absent on purpose. It reads rules across
       * every business, is granted to service_role alone, and is reached only
       * through `callTrusted()`. Typing it here would put a cross-tenant
       * function within reach of the session-scoped client. */

      automation_evaluate_rule: {
        Args: { p_rule_id: string }
        Returns: Database["public"]["Tables"]["automation_runs"]["Row"]
      }

      /** Returns how many rules fired. */
      automation_evaluate_business: {
        Args: { p_business_id: string }
        Returns: number
      }

      alert_acknowledge: {
        Args: { p_alert_id: string }
        Returns: Database["public"]["Tables"]["alerts"]["Row"]
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
      automation_operator: AutomationOperator
      alert_severity: AlertSeverity
      alert_status: AlertStatus
      automation_run_status: AutomationRunStatus
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
export type Integration = T["integrations"]["Row"]
export type IntegrationAccount = T["integration_accounts"]["Row"]
export type SyncJob = T["sync_jobs"]["Row"]
export type SyncRun = T["sync_runs"]["Row"]
export type SyncLog = T["sync_logs"]["Row"]
export type WebhookEvent = T["webhook_events"]["Row"]
export type AutomationRule = T["automation_rules"]["Row"]
export type AutomationRun = T["automation_runs"]["Row"]
export type Alert = T["alerts"]["Row"]
export type Marketplace = T["marketplaces"]["Row"]
export type MarketplaceAccount = T["marketplace_accounts"]["Row"]
export type TaxProfile = T["tax_profiles"]["Row"]
export type SourceRowRecord = T["source_rows"]["Row"]
export type LedgerMappingRule = T["ledger_mapping_rules"]["Row"]
export type Settlement = T["settlements"]["Row"]
export type Payout = T["payouts"]["Row"]
export type FinancialTransaction = T["financial_transactions"]["Row"]
export type LedgerLine = Database["public"]["Views"]["ledger_lines"]["Row"]
export type ClassificationCategoryRow = T["classification_categories"]["Row"]
export type ClassificationRule = T["classification_rules"]["Row"]
export type LedgerClassifiedLine = Database["public"]["Views"]["ledger_classified_lines"]["Row"]

/** A business plus the calling user's role in it. */
export type BusinessWithRole = Business & { role: BusinessRole }
