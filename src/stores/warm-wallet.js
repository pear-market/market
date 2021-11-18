import { ethers } from 'ethers'
import { IndexedDBConnector } from 'anondb/web'
import { ScorchedMarketABI } from 'scorched'
import EspecialClient from 'especial/client'

const GETH_URL = 'wss://goerli.infura.io/ws/v3/5b122dbc87ed4260bf9a2031e8a0e2aa'
// const MARKET_ADDRESS = '0xCB6e1b9D7beD1a5E0cb05648Db5CbD4566788A0e'
const MARKET_ADDRESS = '0x1725e3cd3d6cac9226250981878fc9b5facf4589'

const schema = [
  {
    name: 'Wallet',
    primaryKey: 'address',
    rows: [
      ['address', 'String', { unique: true }],
      ['privateKey', 'String', { unique: true }],
    ]
  },
  {
    name: 'Channel',
    primaryKey: 'id',
    rows: [
      ['id', 'String', { unique: true }],
      ['channelConfig', 'Object'],
      ['suggesterUrl', 'String'],
    ]
  }
]

export default {
  state: {
    db: null,
    wallet: null,
    suggesters: [],
    suggestersByAddress: {},
    suggesterConnectionsByAddress: {},
    answers: [],
  },
  getters: {
    suggesterForAddress: (state) => (_addr) => {
      const addr = ethers.utils.getAddress(_addr)
      return state.suggestersByAddress[addr]
    }
  },
  mutations: {
    ingestAnswers: (state, _answers) => {
      const answers = [_answers].flat()
      const answerIds = answers.reduce((acc, obj) => {
        return { ...acc, [obj.id]: true }
      }, {})
      state.answers = [
        ...answers,
        ...state.answers.filter((a) => !answerIds[a.id]),
      ]
    }
  },
  actions: {
    loadDB: async ({ state }) => {
      if (state.db !== null) return
      state.db = await IndexedDBConnector.create(schema, 1)
    },
    loadWallet: async ({ state, getters }) => {
      if (state.wallet) return state.wallet
      const existingWallet = await state.db.findOne('Wallet', { where: {} })
      if (existingWallet) {
        state.wallet = new ethers.Wallet(existingWallet.privateKey)
      } else {
        const wallet = ethers.Wallet.createRandom()
        await state.db.create('Wallet', {
          address: wallet.address,
          privateKey: wallet.privateKey,
        })
        state.wallet = wallet
      }
      return state.wallet
    },
    loadSuggesters: async ({ state, dispatch }) => {
      const provider = new ethers.providers.WebSocketProvider(GETH_URL)
      const market = new ethers.Contract(MARKET_ADDRESS, ScorchedMarketABI, provider)
      const suggesterCount = +(await market.suggesterCount()).toString()
      const promises = []
      for (let x = 0; x < suggesterCount; x++) {
        promises.push(market.suggesterInfoByIndex(x))
      }
      // slice the 0 address
      state.suggesters = (await Promise.all(promises)).slice(1)
        .map(([address, url, name, bio]) => ({
          address: ethers.utils.getAddress(address),
          url,
          name,
          bio
        }))
        .filter(s => !!s.url)
      state.suggestersByAddress = state.suggesters.reduce((acc, obj) => {
        return {
          ...acc,
          [ethers.utils.getAddress(obj.address)]: obj,
        }
      }, {})
      // attempt to connect to suggesters
      for (const suggester of state.suggesters) {
        dispatch('connectToSuggester', suggester.address)
          .then(() => dispatch('loadSuggesterAnswers', suggester.address))
      }
    },
    connectToSuggester: async ({ state, getters }, _addr) => {
      const suggester = getters.suggesterForAddress(_addr)
      const existingConnection = state.suggesterConnectionsByAddress[suggester.url]
      if (existingConnection) return
      try {
        const client = new EspecialClient(suggester.url)
        state.suggesterConnectionsByAddress[suggester.url] = client
        await client.connect()
      } catch (err) {
        console.log(err)
        console.log('Failed to connect to suggester server')
      }
    },
    loadSuggesterAnswers: async ({ state, getters, commit }, _addr) => {
      const suggester = getters.suggesterForAddress(_addr)
      const client = state.suggesterConnectionsByAddress[suggester.url]
      if (!client || !client.connected) {
        throw new Error(`Suggester not connected: ${_addr}`)
      }
      const { data } = await client.send('asker.load.answers')
      commit('ingestAnswers', data)
    },
    createChannel: async ({ state }) => {

    }
  }
}
