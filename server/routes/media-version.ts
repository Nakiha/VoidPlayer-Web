import {AdminError} from '../admin-error.ts';

/** Derived resources always refer to exactly one content revision. */
export function requireMediaVersion(url:URL) {
  const values=url.searchParams.getAll('v');
  if (values.length !== 1 || !/^[0-9a-f]{24}$/.test(values[0]))
    throw new AdminError(400,'请提供唯一且有效的媒体版本。','media-version-required');
  return values[0];
}
