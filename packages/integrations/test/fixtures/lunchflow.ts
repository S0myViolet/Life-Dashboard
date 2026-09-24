// SYNTHETIC FIXTURE (not captured from the live service)
//
// Shapes follow the ts-rest contract in lunchflow/mcp as summarised in
// docs/research/providers.md: GET /accounts → { accounts }, GET
// /accounts/:id/transactions → { transactions }, GET /accounts/:id/balance →
// { balance }. Every id, key, name and amount below is made up.

export const LUNCHFLOW_TEST_KEY = 'lf_synthetic_key_0123456789abcdefABCDEF'

export const lfAccounts = {
  accounts: [
    {
      id: 101,
      name: 'Synthetic Current Account',
      institution_name: 'Revolut',
      institution_logo: 'https://cdn.example.test/revolut.png',
      provider: 'gocardless',
      currency: 'GBP',
      status: 'ACTIVE',
    },
    {
      id: 202,
      name: 'Synthetic Bank Account',
      institution_name: 'HSBC UK',
      institution_logo: 'http://insecure.example.test/logo.png',
      provider: 'some_new_aggregator',
      currency: 'gbp',
      status: 'DISCONNECTED',
    },
    {
      id: '303',
      name: 'Synthetic Euro Pocket',
      institution_name: null,
      currency: 'EUR',
    },
  ],
}

export const lfBalance = { balance: { available: 1234.5, current: 1200.05, currency: 'GBP' } }

/** Current balance missing, available sent as a string. */
export const lfBalancePartial = { balance: { available: '10.10', current: null, currency: 'GBP' } }

export const lfTransactions = {
  transactions: [
    {
      id: 'txn_0001',
      account_id: 101,
      date: '2026-09-23',
      amount: -12.99,
      currency: 'GBP',
      description: 'SYNTHETIC STREAMING SUBSCRIPTION',
      merchant_name: 'Synthetic Streaming Ltd',
      category: 'Entertainment',
      pending: false,
    },
    {
      id: 5002,
      account_id: 101,
      date: '2026-09-24T08:15:00Z',
      amount: 2500,
      description: 'SYNTHETIC SALARY',
      pending: true,
    },
    {
      id: 'txn_0003',
      account_id: 101,
      date: 'yesterday',
      // Sub-penny precision cannot be represented exactly in GBP minor units.
      amount: 0.123,
      currency: 'GBP',
      description: 'SYNTHETIC INTEREST',
    },
  ],
}

export const lfUnauthorized = { error: 'Unauthorized' }
export const lfInvalidKey = { error: 'InvalidApiKey', message: `Invalid API key ${LUNCHFLOW_TEST_KEY}` }
export const lfAccountNotFound = { error: 'AccountNotFound' }
