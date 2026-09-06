import { serializeRow, serializeRows } from './serializers.js'
import { ConflictError, NotFoundError, ValidationError } from '../utils/errors.js'
import { clean } from '../utils/text.js'

const ROLES = new Set(['admin', 'user'])

/**
 * Account administration.
 *
 * A `user` can browse consultations and keep their own favourites; an `admin`
 * additionally sees the dashboard, the settings and this screen. The split
 * matters because the panel can trigger crawls against a public service and can
 * change how the whole site behaves.
 */
export function createUserService({ users, favorites, auth }) {
  async function list() {
    const rows = await users.listAll()
    return Promise.all(
      rows.map(async (row) => ({ ...serializeRow(row), favoriteCount: await favorites.countForUser(row.id) })),
    )
  }

  /** Creates an account. Delegates hashing and validation to the auth service. */
  const create = ({ email, password, fullName, role = 'user' }) =>
    auth.register({ email, password, fullName, role })

  async function setRole(id, role, actingUserId) {
    if (!ROLES.has(role)) throw new ValidationError(`role must be one of ${[...ROLES].join(', ')}`)
    const user = await users.findById(id)
    if (!user) throw new NotFoundError(`User ${id}`)

    // Removing your own admin rights locks you out of this screen immediately.
    if (Number(id) === Number(actingUserId) && role !== 'admin') {
      throw new ValidationError('You cannot remove your own administrator rights')
    }
    await assertNotLastAdmin(user, role !== 'admin')
    return serializeRow(await users.update(id, { role }))
  }

  async function setActive(id, isActive, actingUserId) {
    const user = await users.findById(id)
    if (!user) throw new NotFoundError(`User ${id}`)
    if (Number(id) === Number(actingUserId) && !isActive) {
      throw new ValidationError('You cannot deactivate your own account')
    }
    await assertNotLastAdmin(user, !isActive)
    return serializeRow(await users.update(id, { is_active: isActive ? 1 : 0 }))
  }

  /** Guards against locking everyone out of the panel. */
  async function assertNotLastAdmin(user, isLosingAdmin) {
    if (!isLosingAdmin || user.role !== 'admin') return
    const admins = (await users.listAll()).filter((row) => row.role === 'admin' && row.is_active)
    if (admins.length <= 1) throw new ConflictError('The last active administrator cannot be removed')
  }

  /** An administrator resetting someone else's password; no old password needed. */
  async function resetPassword(id, newPassword) {
    const user = await users.findById(id)
    if (!user) throw new NotFoundError(`User ${id}`)
    if (!newPassword || newPassword.length < 12) {
      throw new ValidationError('Password must be at least 12 characters')
    }
    await auth.setPassword(id, newPassword)
    return { id: Number(id), updated: true }
  }

  async function remove(id, actingUserId) {
    const user = await users.findById(id)
    if (!user) throw new NotFoundError(`User ${id}`)
    if (Number(id) === Number(actingUserId)) throw new ValidationError('You cannot delete your own account')
    await assertNotLastAdmin(user, true)
    await users.remove(id)
    return { id: Number(id), deleted: true }
  }

  const serialize = serializeRows
  return { list, create, setRole, setActive, resetPassword, remove, serialize }
}
