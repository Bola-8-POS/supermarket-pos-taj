-- =====================================================
-- ENUMS
-- =====================================================

CREATE TYPE user_role AS ENUM ('bartender', 'manager', 'admin');
CREATE TYPE tab_status AS ENUM ('open', 'closed', 'paid', 'voided');
CREATE TYPE order_status AS ENUM ('pending', 'served', 'voided');
CREATE TYPE pool_table_status AS ENUM ('available', 'occupied', 'reserved', 'maintenance');
CREATE TYPE payment_method AS ENUM ('cash', 'card', 'tab_transfer');
