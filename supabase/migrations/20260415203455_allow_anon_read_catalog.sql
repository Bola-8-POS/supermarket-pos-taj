-- Allow any authenticated or anonymous request to read the product catalog
-- Products and categories are not sensitive data — they are the menu

-- Products: anon can SELECT active products
CREATE POLICY "anon_read_active_products"
  ON public.products
  FOR SELECT
  TO anon, authenticated
  USING (is_active = true);

-- Categories: anon can SELECT all categories
CREATE POLICY "anon_read_categories"
  ON public.categories
  FOR SELECT
  TO anon, authenticated
  USING (true);

-- Modifiers: anon can SELECT all modifiers (needed for product display)
CREATE POLICY "anon_read_modifiers"
  ON public.modifiers
  FOR SELECT
  TO anon, authenticated
  USING (true);

-- Product modifier junction: anon can SELECT
CREATE POLICY "anon_read_product_modifiers"
  ON public.product_modifiers
  FOR SELECT
  TO anon, authenticated
  USING (true);
