// src/entities/tab/model/types.ts
export {
  TabSchema,
  OrderSchema,
  OrderItemSchema,
} from '@shared/lib/domain';

export type {
  Tab,
  Order,
  OrderItem,
  TabCreate as CreateTab,
  OrderCreate as CreateOrder,
  OrderItemCreate as CreateOrderItem,
} from '@shared/lib/domain';

import type { Tab, OrderItem } from '@shared/lib/domain';

// =====================================================
// MOCK DATA FOR STORYBOOK
// =====================================================
/* eslint-disable i18next/no-literal-string -- Storybook fixture data, not UI copy. */

export const mockTabItem: OrderItem = {
  id: '123e4567-e89b-12d3-a456-426614174010',
  orderId: '123e4567-e89b-12d3-a456-426614174011',
  productId: '123e4567-e89b-12d3-a456-426614174003',
  quantity: 2,
  unitPrice: 500,
  modifierIds: [],
  modifierPriceDelta: 0,
  notes: null,
  modifiers: [],
};

export const mockTab: Tab = {
  id: '123e4567-e89b-12d3-a456-426614174000',
  customerName: 'Alice Johnson',
  staffId: '123e4567-e89b-12d3-a456-426614174001',
  shiftId: '123e4567-e89b-12d3-a456-426614174002',
  openedAt: new Date(Date.now() - 45 * 60 * 1000), // 45 minutes ago
  closedAt: null,
  status: 'open',
  notes: null,
  orders: [],
  items: [mockTabItem],
  subtotal: 1000,
};
