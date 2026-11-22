// Scenarios `orca plugin check` renders, with the real worker on the same mock host.
import { defineCheck } from 'orca/testing'

const seeded = { seededFromMod: true }

export default defineCheck({
  empty: { storage: { ...seeded, targets: [] } },
  deployments: {
    storage: {
      ...seeded,
      targets: [
        { name: 'local', url: 'http://127.0.0.1:1/health' },
        { name: 'other', url: 'http://127.0.0.1:2/health' },
      ],
    },
  },
  off: { storage: { ...seeded, isOff: true, targets: [{ name: 'local', url: 'http://127.0.0.1:1/health' }] } },
})
