import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/** Marks a route as not requiring a JWT (only /v1/auth/*). */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
