/**
 * MOCK DATA
 *
 * Factories merge defaults with overrides, then validate with Zod schemas from `domain.ts`.
 */

import {
  CategorySchema,
  ProductSchema,
  TabSchema,
  StaffSchema,
  ShiftSchema,
  InventorySchema,
} from '@shared/lib/domain';
import type { Product, Category, Tab, Staff, Shift, Inventory } from '@shared/lib/domain';

// ----------------------------------------------------------------------------
// Stable UUIDs for cross-linked Storybook / scenario data (v4 format)
// ----------------------------------------------------------------------------

export const MOCK_IDS = {
  staffCashier: 'a0000000-0000-4000-8000-000000000001',
  staffManager: 'a0000000-0000-4000-8000-000000000002',
  staffAdmin: 'a0000000-0000-4000-8000-000000000003',
  shiftMain: 'a0000000-0000-4000-8000-000000000010',
  categoryBeer: 'b0000000-0000-4000-8000-000000000001',
  categorySpirits: 'b0000000-0000-4000-8000-000000000002',
  categoryMixers: 'b0000000-0000-4000-8000-000000000003',
  productHeineken: 'c0000000-0000-4000-8000-000000000001',
  productCorona: 'c0000000-0000-4000-8000-000000000002',
  productTitos: 'c0000000-0000-4000-8000-000000000003',
  productLimeJuice: 'c0000000-0000-4000-8000-000000000004',
  productGuinness: 'c0000000-0000-4000-8000-000000000005',
  invCorona: 'e0000000-0000-4000-8000-000000000001',
  invTitos: 'e0000000-0000-4000-8000-000000000002',
  invLime: 'e0000000-0000-4000-8000-000000000003',
} as const;

const TAB_IDS_CLOSING = [
  'f0000000-0000-4000-8000-000000000001',
  'f0000000-0000-4000-8000-000000000002',
  'f0000000-0000-4000-8000-000000000003',
  'f0000000-0000-4000-8000-000000000004',
  'f0000000-0000-4000-8000-000000000005',
] as const;

const TAB_IDS_BUSY = [
  'f1000000-0000-4000-8000-000000000001',
  'f1000000-0000-4000-8000-000000000002',
  'f1000000-0000-4000-8000-000000000003',
  'f1000000-0000-4000-8000-000000000004',
  'f1000000-0000-4000-8000-000000000005',
  'f1000000-0000-4000-8000-000000000006',
  'f1000000-0000-4000-8000-000000000007',
  'f1000000-0000-4000-8000-000000000008',
  'f1000000-0000-4000-8000-000000000009',
  'f1000000-0000-4000-8000-00000000000a',
  'f1000000-0000-4000-8000-00000000000b',
  'f1000000-0000-4000-8000-00000000000c',
] as const;

type Scenario = {
  tabs: Tab[];
  lowStockItems: Inventory[];
};

type StaffRole = 'cashier' | 'manager' | 'admin' | 'kitchen';

const staffRoleDefaults: Record<StaffRole, Pick<Staff, 'name' | 'role' | 'mustChangePin'>> = {
  cashier: {
    name: 'Alex Rivera',
    role: 'cashier',
    mustChangePin: false,
  },
  manager: {
    name: 'Jordan Kim',
    role: 'manager',
    mustChangePin: false,
  },
  admin: {
    name: 'Sam Patel',
    role: 'admin',
    mustChangePin: false,
  },
  kitchen: {
    name: 'Chef Maria',
    role: 'kitchen',
    mustChangePin: false,
  },
};

function openedMinutesAgo(minutes: number): Date {
  return new Date(Date.now() - minutes * 60 * 1000);
}

// ----------------------------------------------------------------------------
// Factories
// ----------------------------------------------------------------------------

export function generateMockCategory(overrides?: Partial<Category>): Category {
  return CategorySchema.parse({
    id: crypto.randomUUID(),
    name: 'Beer',
    color: '#f59e0b',
    sortOrder: 0,
    happyHourStart: '16:00',
    happyHourEnd: '19:00',
    createdAt: new Date(),
    ...overrides,
  });
}

export function generateMockProduct(overrides?: Partial<Product>): Product {
  const defaultCategory = generateMockCategory({
    id: overrides?.categoryId ?? MOCK_IDS.categoryBeer,
    name: 'Beer',
    color: '#f59e0b',
    sortOrder: 0,
    happyHourStart: '16:00',
    happyHourEnd: '19:00',
    createdAt: new Date(),
  });
  const category = overrides?.category ?? defaultCategory;
  const categoryId = overrides?.categoryId ?? category.id;

  return ProductSchema.parse({
    id: crypto.randomUUID(),
    name: 'Heineken',
    basePrice: 7.0,
    happyHourPrice: 5.5,
    sku: 'HEIN-12OZ',
    isActive: true,
    imageUrl: null,
    photoPath: null,
    stock_threshold: null,
    unitsPerPackage: null,
    parentProductId: null,
    brandId: null,
    weightAmount: null,
    weightUnit: null,
    modifiers: [],
    ...overrides,
    categoryId,
    category: overrides?.category ?? category,
  });
}

function generateMockStaff(overrides?: Partial<Staff> & { role?: StaffRole }): Staff {
  const { role: roleFromOverrides, ...rest } = overrides ?? {};
  const role = roleFromOverrides ?? 'cashier';
  const base = staffRoleDefaults[role];

  return StaffSchema.parse({
    id: crypto.randomUUID(),
    ...base,
    isActive: true,
    ...rest,
    role,
  });
}

function generateMockShift(overrides?: Partial<Shift>): Shift {
  return ShiftSchema.parse({
    id: crypto.randomUUID(),
    staffId: MOCK_IDS.staffCashier,
    clockIn: openedMinutesAgo(360),
    clockOut: null,
    openingCash: 200.0,
    closingCash: null,
    ...overrides,
  });
}

function generateMockTab(overrides?: Partial<Tab>): Tab {
  const staff = generateMockStaff({ id: MOCK_IDS.staffCashier, role: 'cashier' });
  const shift = generateMockShift({ id: MOCK_IDS.shiftMain, staffId: staff.id });

  return TabSchema.parse({
    id: crypto.randomUUID(),
    customerName: 'John D.',
    openedAt: openedMinutesAgo(30),
    closedAt: null,
    status: 'open',
    notes: null,
    orders: [],
    items: [],
    ...overrides,
    staffId: overrides?.staffId ?? staff.id,
    shiftId: overrides?.shiftId ?? shift.id,
    staff: overrides?.staff ?? staff,
  });
}

export function generateMockInventory(overrides?: Partial<Inventory>): Inventory {
  const product = overrides?.product ?? generateMockProduct();
  const productId = overrides?.productId ?? product.id;
  const resolvedProduct = overrides?.product ?? product;

  return InventorySchema.parse({
    id: crypto.randomUUID(),
    quantityOnHand: 48,
    lowStockThreshold: 12,
    unit: 'bottles',
    ...overrides,
    productId,
    product: resolvedProduct,
  });
}

// ----------------------------------------------------------------------------
// Scenario presets (Storybook)
// ----------------------------------------------------------------------------

const beerCategory = (): Category =>
  CategorySchema.parse({
    id: MOCK_IDS.categoryBeer,
    name: 'Beer',
    color: '#f59e0b',
    sortOrder: 0,
    happyHourStart: '16:00',
    happyHourEnd: '19:00',
    createdAt: new Date('2024-06-01T18:00:00Z'),
  });

const spiritsCategory = (): Category =>
  CategorySchema.parse({
    id: MOCK_IDS.categorySpirits,
    name: 'Spirits',
    color: '#ef4444',
    sortOrder: 1,
    happyHourStart: null,
    happyHourEnd: null,
    createdAt: new Date('2024-06-01T18:00:00Z'),
  });

const mixersCategory = (): Category =>
  CategorySchema.parse({
    id: MOCK_IDS.categoryMixers,
    name: 'Mixers',
    color: '#22c55e',
    sortOrder: 2,
    happyHourStart: null,
    happyHourEnd: null,
    createdAt: new Date('2024-06-01T18:00:00Z'),
  });

function productCorona(): Product {
  return ProductSchema.parse({
    id: MOCK_IDS.productCorona,
    name: 'Corona Extra',
    categoryId: MOCK_IDS.categoryBeer,
    basePrice: 6.5,
    happyHourPrice: 5.0,
    sku: 'CORONA-12',
    isActive: true,
    imageUrl: null,
    photoPath: null,
    stock_threshold: null,
    unitsPerPackage: null,
    parentProductId: null,
    brandId: null,
    weightAmount: null,
    weightUnit: null,
    modifiers: [],
    category: beerCategory(),
  });
}

function productTitos(): Product {
  return ProductSchema.parse({
    id: MOCK_IDS.productTitos,
    name: "Tito's Handmade Vodka",
    categoryId: MOCK_IDS.categorySpirits,
    basePrice: 9.0,
    happyHourPrice: 7.5,
    sku: 'TITOS-1OZ',
    isActive: true,
    imageUrl: null,
    photoPath: null,
    stock_threshold: null,
    unitsPerPackage: null,
    parentProductId: null,
    brandId: null,
    weightAmount: null,
    weightUnit: null,
    modifiers: [],
    category: spiritsCategory(),
  });
}

function productLime(): Product {
  return ProductSchema.parse({
    id: MOCK_IDS.productLimeJuice,
    name: 'Fresh lime juice (pint)',
    categoryId: MOCK_IDS.categoryMixers,
    basePrice: 4.5,
    happyHourPrice: null,
    sku: 'MIX-LIME-PT',
    isActive: true,
    imageUrl: null,
    photoPath: null,
    stock_threshold: null,
    unitsPerPackage: null,
    parentProductId: null,
    brandId: null,
    weightAmount: null,
    weightUnit: null,
    modifiers: [],
    category: mixersCategory(),
  });
}

function productGuinness(): Product {
  return ProductSchema.parse({
    id: MOCK_IDS.productGuinness,
    name: 'Guinness Draught',
    categoryId: MOCK_IDS.categoryBeer,
    basePrice: 7.5,
    happyHourPrice: 6.0,
    sku: 'GUIN-DRAFT',
    isActive: true,
    imageUrl: null,
    photoPath: null,
    stock_threshold: null,
    unitsPerPackage: null,
    parentProductId: null,
    brandId: null,
    weightAmount: null,
    weightUnit: null,
    modifiers: [],
    category: beerCategory(),
  });
}

function buildClosingTime(): Scenario {
  const customerNames = ['John D.', 'Maria L.', 'Chris P.', 'Taylor M.', 'Riley K.'] as const;
  const tabs = TAB_IDS_CLOSING.map((id, i) =>
    generateMockTab({
      id,
      customerName: customerNames[i]!,
      staffId: MOCK_IDS.staffCashier,
      shiftId: MOCK_IDS.shiftMain,
      notes: i === 0 ? 'Regular — lime with Corona' : null,
    })
  );

  const lowStockItems = [
    generateMockInventory({
      id: MOCK_IDS.invCorona,
      productId: MOCK_IDS.productCorona,
      quantityOnHand: 6,
      lowStockThreshold: 24,
      unit: 'bottles',
      product: productCorona(),
    }),
    generateMockInventory({
      id: MOCK_IDS.invTitos,
      productId: MOCK_IDS.productTitos,
      quantityOnHand: 1,
      lowStockThreshold: 4,
      unit: 'fifths',
      product: productTitos(),
    }),
    generateMockInventory({
      id: MOCK_IDS.invLime,
      productId: MOCK_IDS.productLimeJuice,
      quantityOnHand: 2,
      lowStockThreshold: 8,
      unit: 'pints',
      product: productLime(),
    }),
  ];

  return { tabs, lowStockItems };
}

function buildBusyBar(): Scenario {
  const busyCustomerNames = [
    'Jamie W.',
    'Priya S.',
    'Marcus T.',
    'Elena R.',
    'Noah B.',
    'Sofia G.',
    'Diego V.',
    'Hannah K.',
    'Owen L.',
    'Ava M.',
    'Leo F.',
    'Nina C.',
  ] as const;

  const tabs = TAB_IDS_BUSY.map((id, i) =>
    generateMockTab({
      id,
      customerName: busyCustomerNames[i] ?? `Guest ${i + 1}`,
      staffId: MOCK_IDS.staffCashier,
      shiftId: MOCK_IDS.shiftMain,
      status: 'open',
      notes: i === 3 ? 'Birthday — comp dessert shot' : null,
    })
  );

  const lowStockItems = [
    generateMockInventory({
      product: productCorona(),
      productId: MOCK_IDS.productCorona,
      quantityOnHand: 4,
      lowStockThreshold: 36,
      unit: 'bottles',
    }),
    generateMockInventory({
      product: productGuinness(),
      productId: MOCK_IDS.productGuinness,
      quantityOnHand: 8,
      lowStockThreshold: 24,
      unit: 'cans',
    }),
    generateMockInventory({
      product: productTitos(),
      productId: MOCK_IDS.productTitos,
      quantityOnHand: 2,
      lowStockThreshold: 6,
      unit: 'fifths',
    }),
    generateMockInventory({
      product: productLime(),
      productId: MOCK_IDS.productLimeJuice,
      quantityOnHand: 1,
      lowStockThreshold: 10,
      unit: 'pints',
    }),
    generateMockInventory({
      product: generateMockProduct({
        id: MOCK_IDS.productHeineken,
        name: 'Heineken',
        categoryId: MOCK_IDS.categoryBeer,
        basePrice: 7.0,
        category: beerCategory(),
      }),
      productId: MOCK_IDS.productHeineken,
      quantityOnHand: 10,
      lowStockThreshold: 30,
      unit: 'bottles',
    }),
  ];

  return { tabs, lowStockItems };
}

export const scenarios = {
  busyBar: buildBusyBar(),
  quietNight: {
    tabs: [],
    lowStockItems: [],
  } satisfies Scenario,
  closingTime: buildClosingTime(),
} as const;
