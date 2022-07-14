import './aa.init'
import { BigNumber, Wallet } from 'ethers'
import { expect } from 'chai'
import {
  SimpleWallet,
  SimpleWallet__factory,
  EntryPoint,
  TestCounter,
  TestCounter__factory,
  TestPaymasterAcceptAll,
  TestPaymasterAcceptAll__factory
} from '../typechain'
import {
  AddressZero,
  createWalletOwner,
  fund,
  checkForGeth,
  rethrow,
  tostr,
  getWalletDeployer,
  calcGasUsage,
  checkForBannedOps,
  ONE_ETH,
  TWO_ETH,
  deployEntryPoint,
  getBalance, FIVE_ETH, createAddress, getWalletAddress
} from './testutils'
import { fillAndSign, getRequestId } from './UserOp'
import { UserOperation } from './UserOperation'
import { PopulatedTransaction } from 'ethers/lib/ethers'
import { ethers } from 'hardhat'
import { parseEther } from 'ethers/lib/utils'
import { debugTransaction } from './debugTx'

describe('EntryPoint', function () {
  let entryPoint: EntryPoint
  let entryPointView: EntryPoint

  let walletOwner: Wallet
  const ethersSigner = ethers.provider.getSigner()
  let signer: string
  let wallet: SimpleWallet

  const globalUnstakeDelaySec = 2
  const paymasterStake = ethers.utils.parseEther('2')

  before(async function () {
    signer = await ethersSigner.getAddress()
    await checkForGeth()

    const chainId = await ethers.provider.getNetwork().then(net => net.chainId)

    entryPoint = await deployEntryPoint(paymasterStake, globalUnstakeDelaySec)

    // static call must come from address zero, to validate it can only be called off-chain.
    entryPointView = entryPoint.connect(ethers.provider.getSigner(AddressZero))
    walletOwner = createWalletOwner()
    wallet = await new SimpleWallet__factory(ethersSigner).deploy(entryPoint.address, await walletOwner.getAddress())
    await fund(wallet)

    // sanity: validate helper functions
    const sampleOp = await fillAndSign({ sender: wallet.address }, walletOwner, entryPoint)
    expect(getRequestId(sampleOp, entryPoint.address, chainId)).to.eql(await entryPoint.getRequestId(sampleOp))
  })

  describe('Stake Management', () => {
    let addr: string
    before(async () => {
      addr = await ethersSigner.getAddress()
    })

    it('#getSenderStorage() should get storage cell', async () => {
      await entryPoint.depositTo(signer, { value: FIVE_ETH })
      const cells = await entryPoint.getSenderStorage(signer)
      const val = await ethers.provider.getStorageAt(entryPoint.address, cells[0])
      const mask = BigNumber.from(2).pow(112).sub(1)
      expect(BigNumber.from(val).and(mask)).to.eq(FIVE_ETH)
    })

    it('should deposit for transfer into EntryPoint', async () => {
      const signer2 = ethers.provider.getSigner(2)
      await signer2.sendTransaction({ to: entryPoint.address, value: ONE_ETH })
      expect(await entryPoint.balanceOf(await signer2.getAddress())).to.eql(ONE_ETH)
      expect(await entryPoint.getDepositInfo(await signer2.getAddress())).to.eql({
        deposit: ONE_ETH,
        staked: false,
        stake: 0,
        unstakeDelaySec: 0,
        withdrawTime: 0
      })
    })

    describe('without stake', () => {
      it('should fail to stake too little value', async () => {
        await expect(entryPoint.addStake(2, { value: ONE_ETH })).to.revertedWith('stake value too low')
      })
      it('should fail to stake too little delay', async () => {
        await expect(entryPoint.addStake(1)).to.revertedWith('stake delay too low')
      })
      it('should fail to unlock', async () => {
        await expect(entryPoint.unlockStake()).to.revertedWith('not staked')
      })
    })
    describe('with stake of 2 eth', () => {
      before(async () => {
        await entryPoint.addStake(2, { value: TWO_ETH })
      })
      it('should report "staked" state', async () => {
        const { stake, staked, unstakeDelaySec, withdrawTime } = await entryPoint.getDepositInfo(addr)
        expect({ stake, staked, unstakeDelaySec, withdrawTime }).to.eql({
          stake: parseEther('2'),
          staked: true,
          unstakeDelaySec: 2,
          withdrawTime: 0
        })
      })

      it('should succeed to stake again', async () => {
        const { stake } = await entryPoint.getDepositInfo(addr)
        await entryPoint.addStake(2, { value: ONE_ETH })
        const { stake: stakeAfter } = await entryPoint.getDepositInfo(addr)
        expect(stakeAfter).to.eq(stake.add(ONE_ETH))
      })
      it('should fail to withdraw before unlock', async () => {
        await expect(entryPoint.withdrawStake(AddressZero)).to.revertedWith('must call unlockStake() first')
      })
      describe('with unlocked stake', () => {
        before(async () => {
          await entryPoint.unlockStake()
        })
        it('should report as "not staked"', async () => {
          expect(await entryPoint.getDepositInfo(addr).then(info => info.staked)).to.eq(false)
        })
        it('should report unstake state', async () => {
          const withdrawTime1 = await ethers.provider.getBlock('latest').then(block => block.timestamp) + globalUnstakeDelaySec
          const { stake, staked, unstakeDelaySec, withdrawTime } = await entryPoint.getDepositInfo(addr)
          expect({ stake, staked, unstakeDelaySec, withdrawTime }).to.eql({
            stake: parseEther('3'),
            staked: false,
            unstakeDelaySec: 2,
            withdrawTime: withdrawTime1
          })
        })
        it('should fail to withdraw before unlock timeout', async () => {
          await expect(entryPoint.withdrawStake(AddressZero)).to.revertedWith('Stake withdrawal is not due')
        })
        it('should fail to unlock again', async () => {
          await expect(entryPoint.unlockStake()).to.revertedWith('already unstaking')
        })
        describe('after unstake delay', () => {
          before(async () => {
            // dummy transaction and increase time by 2 seconds
            await ethers.provider.send('evm_increaseTime', [2])
            await ethersSigner.sendTransaction({ to: addr })
          })
          it('adding stake should reset "unlockStake"', async () => {
            let snap
            try {
              snap = await ethers.provider.send('evm_snapshot', [])

              await ethersSigner.sendTransaction({ to: addr })
              await entryPoint.addStake(2, { value: ONE_ETH })
              const { stake, staked, unstakeDelaySec, withdrawTime } = await entryPoint.getDepositInfo(addr)
              expect({ stake, staked, unstakeDelaySec, withdrawTime }).to.eql({
                stake: parseEther('4'),
                staked: true,
                unstakeDelaySec: 2,
                withdrawTime: 0
              })
            } finally {
              await ethers.provider.send('evm_revert', [snap])
            }
          })

          it('should fail to unlock again', async () => {
            await expect(entryPoint.unlockStake()).to.revertedWith('already unstaking')
          })
          it('should succeed to withdraw', async () => {
            const { stake } = await entryPoint.getDepositInfo(addr)
            const addr1 = createAddress()
            await entryPoint.withdrawStake(addr1)
            expect(await ethers.provider.getBalance(addr1)).to.eq(stake)
            const { stake: stakeAfter, withdrawTime, unstakeDelaySec } = await entryPoint.getDepositInfo(addr)

            expect({ stakeAfter, withdrawTime, unstakeDelaySec }).to.eql({
              stakeAfter: BigNumber.from(0),
              unstakeDelaySec: 0,
              withdrawTime: 0
            })
          })
        })
      })
    })
    describe('with deposit', () => {
      let owner: string
      let wallet: SimpleWallet
      before(async () => {
        owner = await ethersSigner.getAddress()
        wallet = await new SimpleWallet__factory(ethersSigner).deploy(entryPoint.address, owner)
        await wallet.addDeposit({ value: ONE_ETH })
        expect(await getBalance(wallet.address)).to.equal(0)
        expect(await wallet.getDeposit()).to.eql(ONE_ETH)
      })
      it('should be able to withdraw', async () => {
        await wallet.withdrawDepositTo(wallet.address, ONE_ETH)
        expect(await getBalance(wallet.address)).to.equal(1e18)
      })
    })
  })

  describe('#simulateValidation', () => {
    const walletOwner1 = createWalletOwner()
    let wallet1: SimpleWallet

    before(async () => {
      wallet1 = await new SimpleWallet__factory(ethersSigner).deploy(entryPoint.address, await walletOwner1.getAddress())
    })

    it('should fail if validateUserOp fails', async () => {
      // using wrong owner for wallet1
      const op = await fillAndSign({ sender: wallet1.address }, walletOwner, entryPoint)
      await expect(entryPointView.callStatic.simulateValidation(op).catch(rethrow())).to
        .revertedWith('wrong signature')
    })

    it('should succeed if validateUserOp succeeds', async () => {
      const op = await fillAndSign({ sender: wallet1.address }, walletOwner1, entryPoint)
      await fund(wallet1)
      await entryPointView.callStatic.simulateValidation(op).catch(rethrow())
    })

    it('should prevent overflows: fail if any numeric value is more than 120 bits', async () => {
      const op = await fillAndSign({
        preVerificationGas: BigNumber.from(2).pow(130),
        sender: wallet1.address
      }, walletOwner1, entryPoint)
      await expect(
        entryPointView.callStatic.simulateValidation(op)
      ).to.revertedWith('gas values overflow')
    })

    it('should fail on-chain', async () => {
      const op = await fillAndSign({ sender: wallet1.address }, walletOwner1, entryPoint)
      await expect(entryPoint.simulateValidation(op)).to.revertedWith('must be called off-chain')
    })

    it('should fail creation for wrong sender', async () => {
      const op1 = await fillAndSign({
        initCode: getWalletDeployer(entryPoint.address, walletOwner1.address),
        sender: '0x'.padEnd(42, '1'),
        verificationGas: 1e6
      }, walletOwner1, entryPoint)
      await expect(entryPointView.callStatic.simulateValidation(op1).catch(rethrow()))
        .to.revertedWith('sender doesn\'t match initCode address')
    })

    it('should succeed for creating a wallet', async () => {
      const sender = getWalletAddress(entryPoint.address, walletOwner1.address)
      const op1 = await fillAndSign({
        sender,
        initCode: getWalletDeployer(entryPoint.address, walletOwner1.address)
      }, walletOwner1, entryPoint)
      await fund(op1.sender)
      console.log('sender=', op1.sender)
      await entryPointView.callStatic.simulateValidation(op1).catch(rethrow())
    })

    it('should not use banned ops during simulateValidation', async () => {
      const op1 = await fillAndSign({
        initCode: getWalletDeployer(entryPoint.address, walletOwner1.address),
        sender: getWalletAddress(entryPoint.address, walletOwner1.address)
      }, walletOwner1, entryPoint)
      await fund(op1.sender)
      await fund(AddressZero)
      // we must create a real transaction to debug, and it must come from address zero:
      await ethers.provider.send('hardhat_impersonateAccount', [AddressZero])
      const ret = await entryPointView.simulateValidation(op1)
      await checkForBannedOps(ret.hash, false)
    })
  })

  describe('without paymaster (account pays in eth)', () => {
    describe('#handleOps', () => {
      let counter: TestCounter
      let walletExecFromEntryPoint: PopulatedTransaction
      before(async () => {
        counter = await new TestCounter__factory(ethersSigner).deploy()
        const count = await counter.populateTransaction.count()
        walletExecFromEntryPoint = await wallet.populateTransaction.execFromEntryPoint(counter.address, 0, count.data!)
      })

      it('wallet should pay for tx', async function () {
        const op = await fillAndSign({
          sender: wallet.address,
          callData: walletExecFromEntryPoint.data,
          verificationGas: 1e6,
          callGas: 1e6
        }, walletOwner, entryPoint)
        const beneficiaryAddress = createAddress()

        const countBefore = await counter.counters(wallet.address)
        // for estimateGas, must specify maxFeePerGas, otherwise our gas check fails
        console.log('  == est gas=', await entryPoint.estimateGas.handleOps([op], beneficiaryAddress, { maxFeePerGas: 1e9 }).then(tostr))

        // must specify at least on of maxFeePerGas, gasLimit
        // (gasLimit, to prevent estimateGas to fail on missing maxFeePerGas, see above..)
        const rcpt = await entryPoint.handleOps([op], beneficiaryAddress, {
          maxFeePerGas: 1e9,
          gasLimit: 1e7
        }).then(async t => await t.wait())

        const countAfter = await counter.counters(wallet.address)
        expect(countAfter.toNumber()).to.equal(countBefore.toNumber() + 1)
        console.log('rcpt.gasUsed=', rcpt.gasUsed.toString(), rcpt.transactionHash)

        await calcGasUsage(rcpt, entryPoint, beneficiaryAddress)
      })

      it('legacy mode (maxPriorityFee==maxFeePerGas) should not use "basefee" opcode', async function () {
        const op = await fillAndSign({
          sender: wallet.address,
          callData: walletExecFromEntryPoint.data,
          maxPriorityFeePerGas: 10e9,
          maxFeePerGas: 10e9,
          verificationGas: 1e6,
          callGas: 1e6
        }, walletOwner, entryPoint)
        const beneficiaryAddress = createAddress()

        // (gasLimit, to prevent estimateGas to fail on missing maxFeePerGas, see above..)
        const rcpt = await entryPoint.handleOps([op], beneficiaryAddress, {
          maxFeePerGas: 1e9,
          gasLimit: 1e7
        }).then(async t => await t.wait())

        const ops = await debugTransaction(rcpt.transactionHash).then(tx => tx.structLogs.map(op => op.op))
        expect(ops).to.include('GAS')
        expect(ops).to.not.include('BASEFEE')
      })

      it('if wallet has a deposit, it should use it to pay', async function () {
        await wallet.addDeposit({ value: ONE_ETH })
        const op = await fillAndSign({
          sender: wallet.address,
          callData: walletExecFromEntryPoint.data,
          verificationGas: 1e6,
          callGas: 1e6
        }, walletOwner, entryPoint)
        const beneficiaryAddress = createAddress()

        const countBefore = await counter.counters(wallet.address)
        // for estimateGas, must specify maxFeePerGas, otherwise our gas check fails
        console.log('  == est gas=', await entryPoint.estimateGas.handleOps([op], beneficiaryAddress, { maxFeePerGas: 1e9 }).then(tostr))

        const balBefore = await getBalance(wallet.address)
        const depositBefore = await entryPoint.balanceOf(wallet.address)
        // must specify at least one of maxFeePerGas, gasLimit
        // (gasLimit, to prevent estimateGas to fail on missing maxFeePerGas, see above..)
        const rcpt = await entryPoint.handleOps([op], beneficiaryAddress, {
          maxFeePerGas: 1e9,
          gasLimit: 1e7
        }).then(async t => await t.wait())

        const countAfter = await counter.counters(wallet.address)
        expect(countAfter.toNumber()).to.equal(countBefore.toNumber() + 1)
        console.log('rcpt.gasUsed=', rcpt.gasUsed.toString(), rcpt.transactionHash)

        const balAfter = await getBalance(wallet.address)
        const depositAfter = await entryPoint.balanceOf(wallet.address)
        expect(balAfter).to.equal(balBefore, 'should pay from stake, not balance')
        const depositUsed = depositBefore.sub(depositAfter)
        expect(await ethers.provider.getBalance(beneficiaryAddress)).to.equal(depositUsed)

        await calcGasUsage(rcpt, entryPoint, beneficiaryAddress)
      })

      it('should pay for reverted tx', async () => {
        const op = await fillAndSign({
          sender: wallet.address,
          callData: '0xdeadface',
          verificationGas: 1e6,
          callGas: 1e6
        }, walletOwner, entryPoint)
        const beneficiaryAddress = createAddress()

        const rcpt = await entryPoint.handleOps([op], beneficiaryAddress, {
          maxFeePerGas: 1e9,
          gasLimit: 1e7
        }).then(async t => await t.wait())

        const [log] = await entryPoint.queryFilter(entryPoint.filters.UserOperationEvent(), rcpt.blockHash)
        expect(log.args.success).to.eq(false)
        expect(await getBalance(beneficiaryAddress)).to.be.gte(1)
      })

      it('#handleOp (single)', async () => {
        const beneficiaryAddress = createAddress()

        const op = await fillAndSign({
          sender: wallet.address,
          callData: walletExecFromEntryPoint.data
        }, walletOwner, entryPoint)

        const countBefore = await counter.counters(wallet.address)
        const rcpt = await entryPoint.handleOps([op], beneficiaryAddress, {
          gasLimit: 1e7
        }).then(async t => await t.wait())
        const countAfter = await counter.counters(wallet.address)
        expect(countAfter.toNumber()).to.equal(countBefore.toNumber() + 1)

        console.log('rcpt.gasUsed=', rcpt.gasUsed.toString(), rcpt.transactionHash)
        await calcGasUsage(rcpt, entryPoint, beneficiaryAddress)
      })
    })

    describe('create account', () => {
      if (process.env.COVERAGE != null) {
        return
      }
      let createOp: UserOperation
      const beneficiaryAddress = createAddress() // 1

      it('should reject create if sender address is wrong', async () => {
        const op = await fillAndSign({
          initCode: getWalletDeployer(entryPoint.address, walletOwner.address),
          verificationGas: 2e6,
          sender: '0x'.padEnd(42, '1')
        }, walletOwner, entryPoint)

        await expect(entryPoint.callStatic.handleOps([op], beneficiaryAddress, {
          gasLimit: 1e7
        })).to.revertedWith('sender doesn\'t match initCode address')
      })

      it('should reject create if account not funded', async () => {
        const op = await fillAndSign({
          initCode: getWalletDeployer(entryPoint.address, walletOwner.address),
          verificationGas: 2e6
        }, walletOwner, entryPoint)

        expect(await ethers.provider.getBalance(op.sender)).to.eq(0)

        await expect(entryPoint.callStatic.handleOps([op], beneficiaryAddress, {
          gasLimit: 1e7,
          gasPrice: await ethers.provider.getGasPrice()
        })).to.revertedWith('didn\'t pay prefund')

        // await expect(await ethers.provider.getCode(op.sender).then(x => x.length)).to.equal(2, "wallet exists before creation")
      })

      it('should succeed to create account after prefund', async () => {
        const preAddr = getWalletAddress(entryPoint.address, walletOwner.address)
        await fund(preAddr)
        createOp = await fillAndSign({
          initCode: getWalletDeployer(entryPoint.address, walletOwner.address),
          callGas: 1e7,
          verificationGas: 2e6

        }, walletOwner, entryPoint)

        await expect(await ethers.provider.getCode(preAddr).then(x => x.length)).to.equal(2, 'wallet exists before creation')
        const rcpt = await entryPoint.handleOps([createOp], beneficiaryAddress, {
          gasLimit: 1e7
        }).then(async tx => await tx.wait()).catch(rethrow())
        await calcGasUsage(rcpt!, entryPoint, beneficiaryAddress)
      })

      it('should reject if account already created', async function () {
        const preAddr = getWalletAddress(entryPoint.address, walletOwner.address)
        if (await ethers.provider.getCode(preAddr).then(x => x.length) === 2) { this.skip() }

        await expect(entryPoint.callStatic.handleOps([createOp], beneficiaryAddress, {
          gasLimit: 1e7
        })).to.revertedWith('sender already constructed')
      })
    })

    describe('batch multiple requests', () => {
      if (process.env.COVERAGE != null) {
        return
      }
      /**
       * attempt a batch:
       * 1. create wallet1 + "initialize" (by calling counter.count())
       * 2. wallet2.exec(counter.count()
       *    (wallet created in advance)
       */
      let counter: TestCounter
      let walletExecCounterFromEntryPoint: PopulatedTransaction
      const beneficiaryAddress = createAddress()
      const walletOwner1 = createWalletOwner()
      let wallet1: string
      const walletOwner2 = createWalletOwner()
      let wallet2: SimpleWallet
      // let prebalance1: BigNumber
      // let prebalance2: BigNumber

      before('before', async () => {
        counter = await new TestCounter__factory(ethersSigner).deploy()
        const count = await counter.populateTransaction.count()
        walletExecCounterFromEntryPoint = await wallet.populateTransaction.execFromEntryPoint(counter.address, 0, count.data!)
        wallet1 = getWalletAddress(entryPoint.address, walletOwner1.address)
        wallet2 = await new SimpleWallet__factory(ethersSigner).deploy(entryPoint.address, walletOwner2.address)
        await fund(wallet1)
        await fund(wallet2.address)
        // execute and incremtn counter
        const op1 = await fillAndSign({
          initCode: getWalletDeployer(entryPoint.address, walletOwner1.address),
          callData: walletExecCounterFromEntryPoint.data,
          callGas: 2e6,
          verificationGas: 2e6
        }, walletOwner1, entryPoint)

        const op2 = await fillAndSign({
          callData: walletExecCounterFromEntryPoint.data,
          sender: wallet2.address,
          callGas: 2e6,
          verificationGas: 76000
        }, walletOwner2, entryPoint)

        await entryPointView.callStatic.simulateValidation(op2, { gasPrice: 1e9 })

        await fund(op1.sender)
        await fund(wallet2.address)
        // prebalance1 = await ethers.provider.getBalance((wallet1))
        // prebalance2 = await ethers.provider.getBalance((wallet2.address))
        await entryPoint.handleOps([op1, op2], beneficiaryAddress).catch((rethrow())).then(async r => await r!.wait())
        // console.log(ret.events!.map(e=>({ev:e.event, ...objdump(e.args!)})))
      })
      it('should execute', async () => {
        expect(await counter.counters(wallet1)).equal(1)
        expect(await counter.counters(wallet2.address)).equal(1)
      })
      it('should pay for tx', async () => {
        // const cost1 = prebalance1.sub(await ethers.provider.getBalance(wallet1))
        // const cost2 = prebalance2.sub(await ethers.provider.getBalance(wallet2.address))
        // console.log('cost1=', cost1)
        // console.log('cost2=', cost2)
      })
    })
  })

  describe('with paymaster (account with no eth)', () => {
    let paymaster: TestPaymasterAcceptAll
    let counter: TestCounter
    let walletExecFromEntryPoint: PopulatedTransaction
    const wallet2Owner = createWalletOwner()

    before(async () => {
      paymaster = await new TestPaymasterAcceptAll__factory(ethersSigner).deploy(entryPoint.address)
      await paymaster.addStake(0, { value: paymasterStake })
      counter = await new TestCounter__factory(ethersSigner).deploy()
      const count = await counter.populateTransaction.count()
      walletExecFromEntryPoint = await wallet.populateTransaction.execFromEntryPoint(counter.address, 0, count.data!)
    })

    it('should fail if paymaster has no deposit', async function () {
      const op = await fillAndSign({
        paymaster: paymaster.address,
        callData: walletExecFromEntryPoint.data,
        initCode: getWalletDeployer(entryPoint.address, wallet2Owner.address),

        verificationGas: 1e6,
        callGas: 1e6
      }, wallet2Owner, entryPoint)
      const beneficiaryAddress = createAddress()
      await expect(entryPoint.handleOps([op], beneficiaryAddress)).to.revertedWith('"paymaster deposit too low"')
    })

    it('paymaster should pay for tx', async function () {
      await paymaster.deposit({ value: ONE_ETH })
      const op = await fillAndSign({
        paymaster: paymaster.address,
        callData: walletExecFromEntryPoint.data,
        initCode: getWalletDeployer(entryPoint.address, wallet2Owner.address)
      }, wallet2Owner, entryPoint)
      const beneficiaryAddress = createAddress()

      const rcpt = await entryPoint.handleOps([op], beneficiaryAddress).then(async t => await t.wait())

      const { actualGasCost } = await calcGasUsage(rcpt, entryPoint, beneficiaryAddress)
      const paymasterPaid = ONE_ETH.sub(await entryPoint.balanceOf(paymaster.address))
      expect(paymasterPaid).to.eql(actualGasCost)
    })
  })
})
