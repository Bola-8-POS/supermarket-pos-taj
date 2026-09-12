export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      agent_audit_log: {
        Row: {
          args: Json | null
          created_at: string
          duration_ms: number | null
          id: string
          result: Json | null
          tool_name: string
          user_id: string | null
          user_role: string | null
        }
        Insert: {
          args?: Json | null
          created_at?: string
          duration_ms?: number | null
          id?: string
          result?: Json | null
          tool_name: string
          user_id?: string | null
          user_role?: string | null
        }
        Update: {
          args?: Json | null
          created_at?: string
          duration_ms?: number | null
          id?: string
          result?: Json | null
          tool_name?: string
          user_id?: string | null
          user_role?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "agent_audit_log_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      audit_log: {
        Row: {
          action: string
          actor_id: string | null
          created_at: string
          details: Json | null
          entity_id: string | null
          entity_type: string | null
          id: string
        }
        Insert: {
          action: string
          actor_id?: string | null
          created_at?: string
          details?: Json | null
          entity_id?: string | null
          entity_type?: string | null
          id?: string
        }
        Update: {
          action?: string
          actor_id?: string | null
          created_at?: string
          details?: Json | null
          entity_id?: string | null
          entity_type?: string | null
          id?: string
        }
        Relationships: [
          {
            foreignKeyName: "audit_log_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      audit_logs: {
        Row: {
          action: string
          actor_id: string | null
          after: Json | null
          before: Json | null
          created_at: string
          entity_id: string | null
          entity_type: string
          id: string
          source: string
          terminal_id: string | null
        }
        Insert: {
          action: string
          actor_id?: string | null
          after?: Json | null
          before?: Json | null
          created_at?: string
          entity_id?: string | null
          entity_type: string
          id?: string
          source?: string
          terminal_id?: string | null
        }
        Update: {
          action?: string
          actor_id?: string | null
          after?: Json | null
          before?: Json | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string
          id?: string
          source?: string
          terminal_id?: string | null
        }
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
      bank_transfers: {
        Row: {
          confirmed_at: string | null
          confirmed_by: string | null
          created_at: string
          created_by: string
          customer_phone: string | null
          dispute_reason: string | null
          disputed_at: string | null
          disputed_by: string | null
          id: string
          payment_id: string
          status: string
        }
        Insert: {
          confirmed_at?: string | null
          confirmed_by?: string | null
          created_at?: string
          created_by: string
          customer_phone?: string | null
          dispute_reason?: string | null
          disputed_at?: string | null
          disputed_by?: string | null
          id?: string
          payment_id: string
          status?: string
        }
        Update: {
          confirmed_at?: string | null
          confirmed_by?: string | null
          created_at?: string
          created_by?: string
          customer_phone?: string | null
          dispute_reason?: string | null
          disputed_at?: string | null
          disputed_by?: string | null
          id?: string
          payment_id?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "bank_transfers_confirmed_by_fkey"
            columns: ["confirmed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bank_transfers_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bank_transfers_disputed_by_fkey"
            columns: ["disputed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bank_transfers_payment_id_fkey"
            columns: ["payment_id"]
            isOneToOne: true
            referencedRelation: "payments"
            referencedColumns: ["id"]
          },
        ]
      }
      brands: {
        Row: {
          created_at: string
          id: string
          name: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          name: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          name?: string
          updated_at?: string
        }
        Relationships: []
      }
      caja_entries: {
        Row: {
          amount: number
          caja_session_id: string
          concept: string
          created_at: string
          id: string
          staff_id: string
          type: string
        }
        Insert: {
          amount: number
          caja_session_id: string
          concept: string
          created_at?: string
          id?: string
          staff_id: string
          type: string
        }
        Update: {
          amount?: number
          caja_session_id?: string
          concept?: string
          created_at?: string
          id?: string
          staff_id?: string
          type?: string
        }
        Relationships: [
          {
            foreignKeyName: "caja_entries_caja_session_id_fkey"
            columns: ["caja_session_id"]
            isOneToOne: false
            referencedRelation: "caja_sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "caja_entries_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      caja_sessions: {
        Row: {
          closed_at: string | null
          closed_by: string | null
          closing_cash: number | null
          created_at: string
          id: string
          notes: string | null
          opened_at: string
          opened_by: string
          opening_cash: number
          status: string
          version: number
        }
        Insert: {
          closed_at?: string | null
          closed_by?: string | null
          closing_cash?: number | null
          created_at?: string
          id?: string
          notes?: string | null
          opened_at?: string
          opened_by: string
          opening_cash?: number
          status?: string
          version?: number
        }
        Update: {
          closed_at?: string | null
          closed_by?: string | null
          closing_cash?: number | null
          created_at?: string
          id?: string
          notes?: string | null
          opened_at?: string
          opened_by?: string
          opening_cash?: number
          status?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "caja_sessions_closed_by_fkey"
            columns: ["closed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "caja_sessions_opened_by_fkey"
            columns: ["opened_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      categories: {
        Row: {
          color: string
          created_at: string
          deleted_at: string | null
          id: string
          name: string
          parent_id: string | null
          routing: Database["public"]["Enums"]["category_routing"]
          sort_order: number
          updated_at: string
        }
        Insert: {
          color?: string
          created_at?: string
          deleted_at?: string | null
          id?: string
          name: string
          parent_id?: string | null
          routing?: Database["public"]["Enums"]["category_routing"]
          sort_order?: number
          updated_at?: string
        }
        Update: {
          color?: string
          created_at?: string
          deleted_at?: string | null
          id?: string
          name?: string
          parent_id?: string | null
          routing?: Database["public"]["Enums"]["category_routing"]
          sort_order?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "categories_parent_id_fkey"
            columns: ["parent_id"]
            isOneToOne: false
            referencedRelation: "categories"
            referencedColumns: ["id"]
          },
        ]
      }
      inventory: {
        Row: {
          cost_price: number | null
          created_at: string
          expiry_date: string | null
          id: string
          low_stock_threshold: number
          product_id: string
          quantity_on_hand: number
          unit: string
          updated_at: string
        }
        Insert: {
          cost_price?: number | null
          created_at?: string
          expiry_date?: string | null
          id?: string
          low_stock_threshold?: number
          product_id: string
          quantity_on_hand?: number
          unit?: string
          updated_at?: string
        }
        Update: {
          cost_price?: number | null
          created_at?: string
          expiry_date?: string | null
          id?: string
          low_stock_threshold?: number
          product_id?: string
          quantity_on_hand?: number
          unit?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "inventory_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: true
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
        ]
      }
      modifier_group_items: {
        Row: {
          group_id: string
          modifier_id: string
          sort_order: number
        }
        Insert: {
          group_id: string
          modifier_id: string
          sort_order?: number
        }
        Update: {
          group_id?: string
          modifier_id?: string
          sort_order?: number
        }
        Relationships: [
          {
            foreignKeyName: "modifier_group_items_group_id_fkey"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "modifier_groups"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "modifier_group_items_modifier_id_fkey"
            columns: ["modifier_id"]
            isOneToOne: false
            referencedRelation: "modifiers"
            referencedColumns: ["id"]
          },
        ]
      }
      modifier_groups: {
        Row: {
          created_at: string
          id: string
          is_required: boolean
          max_select: number
          min_select: number
          name: string
          sort_order: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          is_required?: boolean
          max_select?: number
          min_select?: number
          name: string
          sort_order?: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          is_required?: boolean
          max_select?: number
          min_select?: number
          name?: string
          sort_order?: number
          updated_at?: string
        }
        Relationships: []
      }
      modifiers: {
        Row: {
          created_at: string
          id: string
          name: string
          price_delta: number
          sort_order: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          name: string
          price_delta?: number
          sort_order?: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          name?: string
          price_delta?: number
          sort_order?: number
          updated_at?: string
        }
        Relationships: []
      }
      open_units: {
        Row: {
          closed_at: string | null
          closed_by: string | null
          closed_reason: string | null
          created_at: string
          id: string
          opened_at: string
          opened_by: string | null
          product_id: string
          remaining_count: number
          status: string
          updated_at: string
        }
        Insert: {
          closed_at?: string | null
          closed_by?: string | null
          closed_reason?: string | null
          created_at?: string
          id?: string
          opened_at?: string
          opened_by?: string | null
          product_id: string
          remaining_count: number
          status?: string
          updated_at?: string
        }
        Update: {
          closed_at?: string | null
          closed_by?: string | null
          closed_reason?: string | null
          created_at?: string
          id?: string
          opened_at?: string
          opened_by?: string | null
          product_id?: string
          remaining_count?: number
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "open_units_closed_by_fkey"
            columns: ["closed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "open_units_opened_by_fkey"
            columns: ["opened_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "open_units_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
        ]
      }
      order_items: {
        Row: {
          combo_slot_id: string | null
          cost_price_snapshot: number | null
          created_at: string
          deleted_at: string | null
          discount_amount: number | null
          discount_rate: number | null
          id: string
          is_deleted: boolean
          modifier_ids: string[]
          modifier_price_delta: number
          notes: string | null
          order_id: string
          parent_order_item_id: string | null
          product_id: string
          promotion_id: string | null
          quantity: number
          unit_price: number
          updated_at: string
          weight_grams: number | null
        }
        Insert: {
          combo_slot_id?: string | null
          cost_price_snapshot?: number | null
          created_at?: string
          deleted_at?: string | null
          discount_amount?: number | null
          discount_rate?: number | null
          id?: string
          is_deleted?: boolean
          modifier_ids?: string[]
          modifier_price_delta?: number
          notes?: string | null
          order_id: string
          parent_order_item_id?: string | null
          product_id: string
          promotion_id?: string | null
          quantity?: number
          unit_price: number
          updated_at?: string
          weight_grams?: number | null
        }
        Update: {
          combo_slot_id?: string | null
          cost_price_snapshot?: number | null
          created_at?: string
          deleted_at?: string | null
          discount_amount?: number | null
          discount_rate?: number | null
          id?: string
          is_deleted?: boolean
          modifier_ids?: string[]
          modifier_price_delta?: number
          notes?: string | null
          order_id?: string
          parent_order_item_id?: string | null
          product_id?: string
          promotion_id?: string | null
          quantity?: number
          unit_price?: number
          updated_at?: string
          weight_grams?: number | null
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
            foreignKeyName: "order_items_parent_order_item_id_fkey"
            columns: ["parent_order_item_id"]
            isOneToOne: false
            referencedRelation: "order_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "order_items_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "order_items_promotion_id_fkey"
            columns: ["promotion_id"]
            isOneToOne: false
            referencedRelation: "promotions"
            referencedColumns: ["id"]
          },
        ]
      }
      orders: {
        Row: {
          created_at: string
          deleted_at: string | null
          id: string
          is_deleted: boolean
          notes: string | null
          staff_id: string
          status: Database["public"]["Enums"]["order_status"]
          tab_id: string
          updated_at: string
          void_reason: string | null
          voided_at: string | null
          voided_by: string | null
        }
        Insert: {
          created_at?: string
          deleted_at?: string | null
          id?: string
          is_deleted?: boolean
          notes?: string | null
          staff_id: string
          status?: Database["public"]["Enums"]["order_status"]
          tab_id: string
          updated_at?: string
          void_reason?: string | null
          voided_at?: string | null
          voided_by?: string | null
        }
        Update: {
          created_at?: string
          deleted_at?: string | null
          id?: string
          is_deleted?: boolean
          notes?: string | null
          staff_id?: string
          status?: Database["public"]["Enums"]["order_status"]
          tab_id?: string
          updated_at?: string
          void_reason?: string | null
          voided_at?: string | null
          voided_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "orders_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "orders_tab_id_fkey"
            columns: ["tab_id"]
            isOneToOne: false
            referencedRelation: "tabs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "orders_voided_by_fkey"
            columns: ["voided_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      payments: {
        Row: {
          amount: number
          created_at: string
          deleted_at: string | null
          discount_amount: number | null
          discount_scope: string | null
          discount_type: string | null
          discount_value: number | null
          id: string
          idempotency_key: string
          is_deleted: boolean
          is_refund: boolean
          method: Database["public"]["Enums"]["payment_method"]
          payment_group_id: string | null
          processed_at: string
          processed_by: string
          reference_number: string | null
          refund_id: string | null
          split_index: number | null
          square_payment_id: string | null
          square_receipt_url: string | null
          status: string
          tab_id: string
          tendered_amount: number | null
          updated_at: string
        }
        Insert: {
          amount: number
          created_at?: string
          deleted_at?: string | null
          discount_amount?: number | null
          discount_scope?: string | null
          discount_type?: string | null
          discount_value?: number | null
          id?: string
          idempotency_key: string
          is_deleted?: boolean
          is_refund?: boolean
          method: Database["public"]["Enums"]["payment_method"]
          payment_group_id?: string | null
          processed_at?: string
          processed_by: string
          reference_number?: string | null
          refund_id?: string | null
          split_index?: number | null
          square_payment_id?: string | null
          square_receipt_url?: string | null
          status?: string
          tab_id: string
          tendered_amount?: number | null
          updated_at?: string
        }
        Update: {
          amount?: number
          created_at?: string
          deleted_at?: string | null
          discount_amount?: number | null
          discount_scope?: string | null
          discount_type?: string | null
          discount_value?: number | null
          id?: string
          idempotency_key?: string
          is_deleted?: boolean
          is_refund?: boolean
          method?: Database["public"]["Enums"]["payment_method"]
          payment_group_id?: string | null
          processed_at?: string
          processed_by?: string
          reference_number?: string | null
          refund_id?: string | null
          split_index?: number | null
          square_payment_id?: string | null
          square_receipt_url?: string | null
          status?: string
          tab_id?: string
          tendered_amount?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "payments_processed_by_fkey"
            columns: ["processed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payments_refund_id_fkey"
            columns: ["refund_id"]
            isOneToOne: false
            referencedRelation: "refunds"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payments_tab_id_fkey"
            columns: ["tab_id"]
            isOneToOne: false
            referencedRelation: "tabs"
            referencedColumns: ["id"]
          },
        ]
      }
      pos_codebase_index: {
        Row: {
          chunk_text: string
          embedding: string | null
          file_path: string
          id: string
          indexed_at: string
          metadata: Json | null
        }
        Insert: {
          chunk_text: string
          embedding?: string | null
          file_path: string
          id?: string
          indexed_at?: string
          metadata?: Json | null
        }
        Update: {
          chunk_text?: string
          embedding?: string | null
          file_path?: string
          id?: string
          indexed_at?: string
          metadata?: Json | null
        }
        Relationships: []
      }
      pos_error_log: {
        Row: {
          component: string | null
          created_at: string
          detail: string | null
          error_code: string
          id: string
          message: string
          raw: Json | null
          session_id: string | null
          user_id: string | null
        }
        Insert: {
          component?: string | null
          created_at?: string
          detail?: string | null
          error_code: string
          id?: string
          message: string
          raw?: Json | null
          session_id?: string | null
          user_id?: string | null
        }
        Update: {
          component?: string | null
          created_at?: string
          detail?: string | null
          error_code?: string
          id?: string
          message?: string
          raw?: Json | null
          session_id?: string | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "pos_error_log_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      product_modifier_groups: {
        Row: {
          group_id: string
          product_id: string
          sort_order: number | null
        }
        Insert: {
          group_id: string
          product_id: string
          sort_order?: number | null
        }
        Update: {
          group_id?: string
          product_id?: string
          sort_order?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "product_modifier_groups_group_id_fkey"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "modifier_groups"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "product_modifier_groups_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
        ]
      }
      product_modifiers: {
        Row: {
          created_at: string
          modifier_id: string
          product_id: string
        }
        Insert: {
          created_at?: string
          modifier_id: string
          product_id: string
        }
        Update: {
          created_at?: string
          modifier_id?: string
          product_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "product_modifiers_modifier_id_fkey"
            columns: ["modifier_id"]
            isOneToOne: false
            referencedRelation: "modifiers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "product_modifiers_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
        ]
      }
      products: {
        Row: {
          barcode: string | null
          base_price: number
          brand_id: string | null
          category_id: string
          combo_eligible: boolean
          combo_price_override: number | null
          created_at: string
          deleted_at: string | null
          id: string
          image_url: string | null
          is_active: boolean
          is_combo: boolean
          name: string
          parent_product_id: string | null
          photo_path: string | null
          sku: string | null
          sold_by_weight: boolean
          stock_threshold: number | null
          units_per_package: number | null
          updated_at: string
          weight_amount: number | null
          weight_unit: string | null
        }
        Insert: {
          barcode?: string | null
          base_price: number
          brand_id?: string | null
          category_id: string
          combo_eligible?: boolean
          combo_price_override?: number | null
          created_at?: string
          deleted_at?: string | null
          id?: string
          image_url?: string | null
          is_active?: boolean
          is_combo?: boolean
          name: string
          parent_product_id?: string | null
          photo_path?: string | null
          sku?: string | null
          sold_by_weight?: boolean
          stock_threshold?: number | null
          units_per_package?: number | null
          updated_at?: string
          weight_amount?: number | null
          weight_unit?: string | null
        }
        Update: {
          barcode?: string | null
          base_price?: number
          brand_id?: string | null
          category_id?: string
          combo_eligible?: boolean
          combo_price_override?: number | null
          created_at?: string
          deleted_at?: string | null
          id?: string
          image_url?: string | null
          is_active?: boolean
          is_combo?: boolean
          name?: string
          parent_product_id?: string | null
          photo_path?: string | null
          sku?: string | null
          sold_by_weight?: boolean
          stock_threshold?: number | null
          units_per_package?: number | null
          updated_at?: string
          weight_amount?: number | null
          weight_unit?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "products_brand_id_fkey"
            columns: ["brand_id"]
            isOneToOne: false
            referencedRelation: "brands"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "products_category_id_fkey"
            columns: ["category_id"]
            isOneToOne: false
            referencedRelation: "categories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "products_parent_product_id_fkey"
            columns: ["parent_product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          created_at: string
          deleted_at: string | null
          email: string | null
          id: string
          is_active: boolean
          locale: string
          must_change_pin: boolean
          name: string
          pin: string
          role: Database["public"]["Enums"]["user_role"]
          updated_at: string
        }
        Insert: {
          created_at?: string
          deleted_at?: string | null
          email?: string | null
          id: string
          is_active?: boolean
          locale?: string
          must_change_pin?: boolean
          name: string
          pin: string
          role?: Database["public"]["Enums"]["user_role"]
          updated_at?: string
        }
        Update: {
          created_at?: string
          deleted_at?: string | null
          email?: string | null
          id?: string
          is_active?: boolean
          locale?: string
          must_change_pin?: boolean
          name?: string
          pin?: string
          role?: Database["public"]["Enums"]["user_role"]
          updated_at?: string
        }
        Relationships: []
      }
      promotion_targets: {
        Row: {
          category_id: string | null
          created_at: string
          id: string
          product_id: string | null
          promotion_id: string
        }
        Insert: {
          category_id?: string | null
          created_at?: string
          id?: string
          product_id?: string | null
          promotion_id: string
        }
        Update: {
          category_id?: string | null
          created_at?: string
          id?: string
          product_id?: string | null
          promotion_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "promotion_targets_category_id_fkey"
            columns: ["category_id"]
            isOneToOne: false
            referencedRelation: "categories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "promotion_targets_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "promotion_targets_promotion_id_fkey"
            columns: ["promotion_id"]
            isOneToOne: false
            referencedRelation: "promotions"
            referencedColumns: ["id"]
          },
        ]
      }
      promotions: {
        Row: {
          active: boolean
          created_at: string
          created_by: string | null
          days_of_week: number[] | null
          discount_type: string
          discount_value: number
          end_time: string | null
          ends_at: string
          id: string
          name: string
          needs_review: boolean
          start_time: string | null
          starts_at: string
          updated_at: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          created_by?: string | null
          days_of_week?: number[] | null
          discount_type: string
          discount_value: number
          end_time?: string | null
          ends_at: string
          id?: string
          name: string
          needs_review?: boolean
          start_time?: string | null
          starts_at: string
          updated_at?: string
        }
        Update: {
          active?: boolean
          created_at?: string
          created_by?: string | null
          days_of_week?: number[] | null
          discount_type?: string
          discount_value?: number
          end_time?: string | null
          ends_at?: string
          id?: string
          name?: string
          needs_review?: boolean
          start_time?: string | null
          starts_at?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "promotions_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      purchase_order_items: {
        Row: {
          cost_price: number
          id: string
          product_id: string
          purchase_order_id: string
          quantity: number
        }
        Insert: {
          cost_price?: number
          id?: string
          product_id: string
          purchase_order_id: string
          quantity: number
        }
        Update: {
          cost_price?: number
          id?: string
          product_id?: string
          purchase_order_id?: string
          quantity?: number
        }
        Relationships: [
          {
            foreignKeyName: "purchase_order_items_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchase_order_items_purchase_order_id_fkey"
            columns: ["purchase_order_id"]
            isOneToOne: false
            referencedRelation: "purchase_orders"
            referencedColumns: ["id"]
          },
        ]
      }
      purchase_orders: {
        Row: {
          created_at: string
          created_by: string
          id: string
          received_at: string | null
          status: string
          supplier_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string
          id?: string
          received_at?: string | null
          status?: string
          supplier_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string
          id?: string
          received_at?: string | null
          status?: string
          supplier_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "purchase_orders_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchase_orders_supplier_id_fkey"
            columns: ["supplier_id"]
            isOneToOne: false
            referencedRelation: "suppliers"
            referencedColumns: ["id"]
          },
        ]
      }
      receipt_settings: {
        Row: {
          auto_cut: boolean
          bold_totals: boolean
          footer_text: string
          header_line_2: string
          id: string
          kds_enabled: boolean
          logo_data_url: string | null
          paper_width_chars: number
          print_on_start: boolean
          printer_name: string | null
          show_cashier_name: boolean
          show_customer_name: boolean
          show_receipt_number: boolean
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          auto_cut?: boolean
          bold_totals?: boolean
          footer_text?: string
          header_line_2?: string
          id?: string
          kds_enabled?: boolean
          logo_data_url?: string | null
          paper_width_chars?: number
          print_on_start?: boolean
          printer_name?: string | null
          show_cashier_name?: boolean
          show_customer_name?: boolean
          show_receipt_number?: boolean
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          auto_cut?: boolean
          bold_totals?: boolean
          footer_text?: string
          header_line_2?: string
          id?: string
          kds_enabled?: boolean
          logo_data_url?: string | null
          paper_width_chars?: number
          print_on_start?: boolean
          printer_name?: string | null
          show_cashier_name?: boolean
          show_customer_name?: boolean
          show_receipt_number?: boolean
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "receipt_settings_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      refund_items: {
        Row: {
          amount: number
          created_at: string
          id: string
          order_item_id: string
          qty: number
          refund_id: string
          restock: boolean
        }
        Insert: {
          amount: number
          created_at?: string
          id?: string
          order_item_id: string
          qty: number
          refund_id: string
          restock?: boolean
        }
        Update: {
          amount?: number
          created_at?: string
          id?: string
          order_item_id?: string
          qty?: number
          refund_id?: string
          restock?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "refund_items_order_item_id_fkey"
            columns: ["order_item_id"]
            isOneToOne: false
            referencedRelation: "order_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "refund_items_refund_id_fkey"
            columns: ["refund_id"]
            isOneToOne: false
            referencedRelation: "refunds"
            referencedColumns: ["id"]
          },
        ]
      }
      refunds: {
        Row: {
          amount: number
          created_at: string
          created_by: string
          id: string
          original_payment_id: string
          reason: string
        }
        Insert: {
          amount: number
          created_at?: string
          created_by: string
          id?: string
          original_payment_id: string
          reason: string
        }
        Update: {
          amount?: number
          created_at?: string
          created_by?: string
          id?: string
          original_payment_id?: string
          reason?: string
        }
        Relationships: [
          {
            foreignKeyName: "refunds_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "refunds_original_payment_id_fkey"
            columns: ["original_payment_id"]
            isOneToOne: false
            referencedRelation: "payments"
            referencedColumns: ["id"]
          },
        ]
      }
      role_permissions: {
        Row: {
          action: string
          created_at: string
          id: string
          role: Database["public"]["Enums"]["user_role"]
        }
        Insert: {
          action: string
          created_at?: string
          id?: string
          role: Database["public"]["Enums"]["user_role"]
        }
        Update: {
          action?: string
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["user_role"]
        }
        Relationships: []
      }
      settings: {
        Row: {
          id: string
          key: string
          updated_at: string
          updated_by: string | null
          value: Json
        }
        Insert: {
          id?: string
          key: string
          updated_at?: string
          updated_by?: string | null
          value: Json
        }
        Update: {
          id?: string
          key?: string
          updated_at?: string
          updated_by?: string | null
          value?: Json
        }
        Relationships: [
          {
            foreignKeyName: "settings_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      settings_backups: {
        Row: {
          created_at: string
          created_by: string | null
          id: string
          label: string
          restored_at: string | null
          restored_by: string | null
          snapshot: Json
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          id?: string
          label: string
          restored_at?: string | null
          restored_by?: string | null
          snapshot: Json
        }
        Update: {
          created_at?: string
          created_by?: string | null
          id?: string
          label?: string
          restored_at?: string | null
          restored_by?: string | null
          snapshot?: Json
        }
        Relationships: [
          {
            foreignKeyName: "settings_backups_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "settings_backups_restored_by_fkey"
            columns: ["restored_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      shifts: {
        Row: {
          clock_in: string
          clock_out: string | null
          closing_cash: number | null
          created_at: string
          id: string
          opening_cash: number
          staff_id: string
          updated_at: string
        }
        Insert: {
          clock_in?: string
          clock_out?: string | null
          closing_cash?: number | null
          created_at?: string
          id?: string
          opening_cash?: number
          staff_id: string
          updated_at?: string
        }
        Update: {
          clock_in?: string
          clock_out?: string | null
          closing_cash?: number | null
          created_at?: string
          id?: string
          opening_cash?: number
          staff_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "shifts_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      shipments: {
        Row: {
          id: string
          po_id: string | null
          received_at: string
          received_by: string
          supplier_id: string
        }
        Insert: {
          id?: string
          po_id?: string | null
          received_at?: string
          received_by: string
          supplier_id: string
        }
        Update: {
          id?: string
          po_id?: string | null
          received_at?: string
          received_by?: string
          supplier_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "shipments_po_id_fkey"
            columns: ["po_id"]
            isOneToOne: false
            referencedRelation: "purchase_orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shipments_received_by_fkey"
            columns: ["received_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shipments_supplier_id_fkey"
            columns: ["supplier_id"]
            isOneToOne: false
            referencedRelation: "suppliers"
            referencedColumns: ["id"]
          },
        ]
      }
      stock_movements: {
        Row: {
          created_at: string
          id: string
          ingredient_id: string | null
          notes: string | null
          product_id: string | null
          quantity_delta: number
          reason: string
          ref_id: string | null
          ref_type: string | null
          staff_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          ingredient_id?: string | null
          notes?: string | null
          product_id?: string | null
          quantity_delta: number
          reason: string
          ref_id?: string | null
          ref_type?: string | null
          staff_id: string
        }
        Update: {
          created_at?: string
          id?: string
          ingredient_id?: string | null
          notes?: string | null
          product_id?: string | null
          quantity_delta?: number
          reason?: string
          ref_id?: string | null
          ref_type?: string | null
          staff_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "inventory_log_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inventory_log_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      supplier_products: {
        Row: {
          created_at: string
          id: string
          product_id: string
          supplier_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          product_id: string
          supplier_id: string
        }
        Update: {
          created_at?: string
          id?: string
          product_id?: string
          supplier_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "supplier_products_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "supplier_products_supplier_id_fkey"
            columns: ["supplier_id"]
            isOneToOne: false
            referencedRelation: "suppliers"
            referencedColumns: ["id"]
          },
        ]
      }
      suppliers: {
        Row: {
          address: string | null
          contact_name: string | null
          created_at: string
          email: string | null
          id: string
          name: string
          notes: string | null
          phone: string | null
          updated_at: string
        }
        Insert: {
          address?: string | null
          contact_name?: string | null
          created_at?: string
          email?: string | null
          id?: string
          name: string
          notes?: string | null
          phone?: string | null
          updated_at?: string
        }
        Update: {
          address?: string | null
          contact_name?: string | null
          created_at?: string
          email?: string | null
          id?: string
          name?: string
          notes?: string | null
          phone?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      tabs: {
        Row: {
          caja_session_id: string | null
          closed_at: string | null
          created_at: string
          customer_name: string | null
          deleted_at: string | null
          id: string
          is_deleted: boolean
          last_reopened_at: string | null
          notes: string | null
          opened_at: string
          rappi_order_id: string | null
          reopen_count: number
          shift_id: string
          staff_id: string
          status: Database["public"]["Enums"]["tab_status"]
          table_number: number | null
          updated_at: string
          version: number
        }
        Insert: {
          caja_session_id?: string | null
          closed_at?: string | null
          created_at?: string
          customer_name?: string | null
          deleted_at?: string | null
          id?: string
          is_deleted?: boolean
          last_reopened_at?: string | null
          notes?: string | null
          opened_at?: string
          rappi_order_id?: string | null
          reopen_count?: number
          shift_id: string
          staff_id: string
          status?: Database["public"]["Enums"]["tab_status"]
          table_number?: number | null
          updated_at?: string
          version?: number
        }
        Update: {
          caja_session_id?: string | null
          closed_at?: string | null
          created_at?: string
          customer_name?: string | null
          deleted_at?: string | null
          id?: string
          is_deleted?: boolean
          last_reopened_at?: string | null
          notes?: string | null
          opened_at?: string
          rappi_order_id?: string | null
          reopen_count?: number
          shift_id?: string
          staff_id?: string
          status?: Database["public"]["Enums"]["tab_status"]
          table_number?: number | null
          updated_at?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "tabs_caja_session_id_fkey"
            columns: ["caja_session_id"]
            isOneToOne: false
            referencedRelation: "caja_sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tabs_shift_id_fkey"
            columns: ["shift_id"]
            isOneToOne: false
            referencedRelation: "shifts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tabs_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      terminal_lock_settings: {
        Row: {
          lock_timeout_seconds: number
          terminal_id: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          lock_timeout_seconds?: number
          terminal_id: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          lock_timeout_seconds?: number
          terminal_id?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "terminal_lock_settings_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      bank_transfer_generate_unique_code: { Args: never; Returns: string }
      bank_transfer_is_valid_code: {
        Args: { p_code: string }
        Returns: boolean
      }
      bank_transfer_luhn_check_digit: {
        Args: { p_payload: string }
        Returns: number
      }
      caja_open: {
        Args: {
          p_opened_by: string
          p_opening_cash: number
          p_terminal_id?: string
        }
        Returns: {
          closed_at: string | null
          closed_by: string | null
          closing_cash: number | null
          created_at: string
          id: string
          notes: string | null
          opened_at: string
          opened_by: string
          opening_cash: number
          status: string
          version: number
        }
        SetofOptions: {
          from: "*"
          to: "caja_sessions"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      clear_must_change_pin: {
        Args: { p_new_pin: string; p_terminal_id?: string }
        Returns: Json
      }
      close_caja_session: {
        Args: {
          p_caja_id: string
          p_closed_by: string
          p_closing_cash: number
          p_notes?: string
        }
        Returns: Json
      }
      close_tab: {
        Args: {
          p_expected_version?: number
          p_status: Database["public"]["Enums"]["tab_status"]
          p_tab_id: string
          p_terminal_id?: string
        }
        Returns: Json
      }
      confirm_transfer_payment: {
        Args: { p_entered_code: string; p_payment_id: string }
        Returns: Json
      }
      consume_open_unit: {
        Args: {
          p_allow_negative?: boolean
          p_direction: number
          p_order_item_id: string
          p_product_id: string
          p_qty: number
        }
        Returns: undefined
      }
      correct_open_unit: {
        Args: {
          p_open_unit_id: string
          p_reason: string
          p_remaining_count: number
        }
        Returns: undefined
      }
      create_order_with_items: {
        Args: {
          p_expected_version?: number
          p_items: Json
          p_notes: string
          p_skip_depletion?: boolean
          p_staff_id: string
          p_status: Database["public"]["Enums"]["order_status"]
          p_tab_id: string
        }
        Returns: Json
      }
      deplete_for_order_item: {
        Args: {
          p_allow_negative?: boolean
          p_direction: number
          p_order_item_id: string
        }
        Returns: undefined
      }
      dispute_transfer_payment: {
        Args: { p_payment_id: string; p_reason: string }
        Returns: Json
      }
      edit_paid_tab: {
        Args: {
          p_expected_version: number
          p_manager_pin?: string
          p_notes: string
          p_order_item_patches: Json
          p_reason: string
          p_tab_id: string
        }
        Returns: Json
      }
      force_pin_change: {
        Args: { p_staff_id: string; p_terminal_id?: string }
        Returns: Json
      }
      get_caja_report: { Args: { p_caja_id: string }; Returns: Json }
      get_category_revenue_report: {
        Args: { p_from: string; p_to: string }
        Returns: Json
      }
      get_deletions_post_report: {
        Args: { p_from: string; p_to: string }
        Returns: Json
      }
      get_deletions_pre_report: {
        Args: { p_from: string; p_to: string }
        Returns: Json
      }
      get_payment_methods_report: {
        Args: { p_from: string; p_to: string }
        Returns: Json
      }
      get_payments_split_columns: {
        Args: never
        Returns: {
          column_name: string
          data_type: string
          is_nullable: string
        }[]
      }
      get_peak_hours_report: {
        Args: { p_from: string; p_to: string }
        Returns: Json
      }
      get_product_sales_report: {
        Args: { p_from: string; p_to: string }
        Returns: Json
      }
      get_stock_movement_deltas_after: {
        Args: { p_after: string }
        Returns: Json
      }
      get_stock_movement_deltas_two_cutoffs: {
        Args: { p_from: string; p_to: string }
        Returns: Json
      }
      get_user_role: {
        Args: never
        Returns: Database["public"]["Enums"]["user_role"]
      }
      get_voids_report: {
        Args: { p_from: string; p_to: string }
        Returns: Json
      }
      list_caja_sessions: { Args: { p_limit?: number }; Returns: Json }
      match_codebase_chunks: {
        Args: {
          match_count?: number
          query_embedding: string
          similarity_threshold?: number
        }
        Returns: {
          chunk_text: string
          file_path: string
          id: string
          metadata: Json
          similarity: number
        }[]
      }
      open_open_unit: { Args: { p_product_id: string }; Returns: string }
      process_direct_sale_atomic: {
        Args: {
          p_amount?: number
          p_caja_session_id: string
          p_customer_name?: string
          p_customer_phone?: string
          p_discount_amount?: number
          p_discount_scope?: string
          p_discount_type?: string
          p_discount_value?: number
          p_expected_total?: number
          p_idempotency_key: string
          p_items: Json
          p_legs?: Json
          p_manager_override?: boolean
          p_manager_pin?: string
          p_method?: string
          p_reference_number?: string
          p_shift_id: string
          p_staff_id: string
          p_tendered_amount?: number
        }
        Returns: Json
      }
      process_payment_atomic: {
        Args: {
          p_amount: number
          p_customer_phone?: string
          p_discount_amount?: number
          p_discount_scope?: string
          p_discount_type?: string
          p_discount_value?: number
          p_expected_version?: number
          p_idempotency_key: string
          p_manager_override?: boolean
          p_manager_pin?: string
          p_method: string
          p_rappi_order_id?: string
          p_reference_number?: string
          p_staff_id: string
          p_tab_id: string
          p_tendered_amount?: number
        }
        Returns: Json
      }
      process_refund: {
        Args: {
          p_items: Json
          p_manager_pin: string
          p_original_payment_id: string
          p_reason: string
        }
        Returns: string
      }
      process_split_payment_atomic: {
        Args: {
          p_discount_amount?: number
          p_discount_scope?: string
          p_discount_type?: string
          p_discount_value?: number
          p_expected_total: number
          p_expected_version?: number
          p_idempotency_key: string
          p_legs: Json
          p_manager_override?: boolean
          p_manager_pin?: string
          p_staff_id: string
          p_tab_id: string
        }
        Returns: Json
      }
      receive_shipment: {
        Args: {
          p_items: Json
          p_po_id?: string
          p_staff_id: string
          p_supplier_id: string
        }
        Returns: Json
      }
      record_audit: {
        Args: {
          p_action: string
          p_after?: Json
          p_before?: Json
          p_entity_id?: string
          p_entity_type: string
          p_source?: string
          p_terminal_id?: string
          p_user_id?: string
        }
        Returns: string
      }
      remove_tab_item: {
        Args: { p_item_id: string; p_reason: string }
        Returns: Json
      }
      reopen_tab: {
        Args: {
          p_expected_version: number
          p_manager_pin?: string
          p_reason: string
          p_tab_id: string
        }
        Returns: Json
      }
      set_own_locale: {
        Args: { p_locale: string; p_terminal_id?: string }
        Returns: Json
      }
      update_purchase_order_atomic: {
        Args: { p_id: string; p_items: Json; p_supplier_id: string }
        Returns: undefined
      }
      void_open_unit: {
        Args: { p_open_unit_id: string; p_reason: string }
        Returns: undefined
      }
    }
    Enums: {
      category_routing: "KITCHEN" | "BAR" | "NONE"
      order_status: "pending" | "served" | "voided"
      payment_method:
        | "cash"
        | "card"
        | "tab_transfer"
        | "rappi"
        | "bank_transfer"
        | "uber_eats"
      tab_status: "open" | "closed" | "paid" | "voided" | "split"
      user_role: "cashier" | "manager" | "admin" | "kitchen"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {
      category_routing: ["KITCHEN", "BAR", "NONE"],
      order_status: ["pending", "served", "voided"],
      payment_method: [
        "cash",
        "card",
        "tab_transfer",
        "rappi",
        "bank_transfer",
        "uber_eats",
      ],
      tab_status: ["open", "closed", "paid", "voided", "split"],
      user_role: ["cashier", "manager", "admin", "kitchen"],
    },
  },
} as const

