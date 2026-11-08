-- =====================================================
-- PRODUCTS, CATEGORIES & MODIFIERS
-- =====================================================

-- Categories
CREATE TABLE categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100) NOT NULL,
  color VARCHAR(7) NOT NULL DEFAULT '#6B7280',
  sort_order INT NOT NULL DEFAULT 0,
  happy_hour_start TIME,
  happy_hour_end TIME,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT color_hex_format CHECK (color ~ '^#[0-9A-Fa-f]{6}$'),
  CONSTRAINT happy_hour_valid CHECK (
    (happy_hour_start IS NULL AND happy_hour_end IS NULL) OR
    (happy_hour_start IS NOT NULL AND happy_hour_end IS NOT NULL)
  )
);

CREATE INDEX idx_categories_sort_order ON categories(sort_order);

-- Products
CREATE TABLE products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  category_id UUID NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
  base_price NUMERIC(10, 2) NOT NULL,
  happy_hour_price NUMERIC(10, 2),
  sku VARCHAR(50),
  is_active BOOLEAN NOT NULL DEFAULT true,
  image_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT base_price_positive CHECK (base_price >= 0),
  CONSTRAINT happy_hour_price_positive CHECK (happy_hour_price IS NULL OR happy_hour_price >= 0),
  CONSTRAINT sku_unique UNIQUE (sku)
);

CREATE INDEX idx_products_category_id ON products(category_id);
CREATE INDEX idx_products_is_active ON products(is_active);
CREATE INDEX idx_products_name ON products(name);

-- Modifiers
CREATE TABLE modifiers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100) NOT NULL,
  price_delta NUMERIC(10, 2) NOT NULL DEFAULT 0,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_modifiers_sort_order ON modifiers(sort_order);

-- Product Modifiers (junction table)
CREATE TABLE product_modifiers (
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  modifier_id UUID NOT NULL REFERENCES modifiers(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (product_id, modifier_id)
);

CREATE INDEX idx_product_modifiers_product_id ON product_modifiers(product_id);
CREATE INDEX idx_product_modifiers_modifier_id ON product_modifiers(modifier_id);
