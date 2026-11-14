import { z } from 'zod';

/** Customer email for receipt delivery. */
export const ReceiptEmailSchema = z.string().trim().pipe(z.email('Enter a valid email address'));
