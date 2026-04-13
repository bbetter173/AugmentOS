// Note: these values must stay in sync with AppPermissionType from @mentra/types.
// We cannot use `satisfies readonly AppPermissionType[]` here because @mentra/types
// is not a dependency of this lightweight CLI package.
export const ALLOWED_PERMISSIONS = [
  'MICROPHONE',
  'CAMERA',
  'CALENDAR',
  'LOCATION',
  'BACKGROUND_LOCATION',
  'READ_NOTIFICATIONS',
  'POST_NOTIFICATIONS',
] as const;

export type AllowedPermission = (typeof ALLOWED_PERMISSIONS)[number];

export function validateManifest(manifest: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (typeof manifest !== 'object' || manifest === null) {
    return { valid: false, errors: ['Manifest must be a JSON object'] };
  }

  const m = manifest as Record<string, unknown>;

  if (typeof m.packageName !== 'string' || !m.packageName) {
    errors.push('packageName must be a non-empty string');
  }

  if (typeof m.version !== 'string' || !m.version) {
    errors.push('version must be a non-empty string');
  }

  if (typeof m.name !== 'string' || !m.name) {
    errors.push('name must be a non-empty string');
  }

  if (m.permissions !== undefined) {
    if (!Array.isArray(m.permissions)) {
      errors.push('permissions must be an array');
    } else {
      for (const perm of m.permissions) {
        if (!(ALLOWED_PERMISSIONS as readonly string[]).includes(perm)) {
          errors.push(`Unknown permission: ${perm}. Allowed: ${ALLOWED_PERMISSIONS.join(', ')}`);
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}
