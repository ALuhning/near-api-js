const { Account, KeyPair, Near, InMemoryKeyStore } = require('../');
const  { aliceAccountName, newAccountCodeHash, storageAccountIdKey, createFakeStorage, sleep } = require('./test-utils');
const dev = require('../dev');
const fs = require('fs');
let nearjs;
let account;
let keyStore;

beforeAll(async () => {
    // To avoid nonce collisions with promise test on alice
    await sleep(1000);

    keyStore = new InMemoryKeyStore();
    const storage = createFakeStorage();
    nearjs = await dev.connect({
        nodeUrl: 'http://localhost:3030',
        useDevAccount: true,
        deps: { keyStore, storage },
    });
    account = new Account(nearjs.nearClient);
});

test('test creating default config', async () => {
    // Make sure createDefaultConfig doesn't crash.
    Near.createDefaultConfig();
});

describe('dev connect', () => {
    let deps;
    let options;
    beforeEach(async () => {
        const keyStore = new InMemoryKeyStore();
        const storage = createFakeStorage();   
        deps = {
            keyStore,
            storage,
            createAccount: dev.createAccountWithLocalNodeConnection
        };
        options = {
            deps,
        };
    });

    test('test dev connect with no account creates a new account', async () => {
        await dev.connect(options);
        expect(Object.keys(deps.keyStore.keys).length).toEqual(2); // one key for dev account and one key for the new account.
        const newAccountId = deps.storage.getItem(storageAccountIdKey);
        const viewAccountResponse = await account.viewAccount(newAccountId);
        const newAccountKeyPair = await deps.keyStore.getKey(newAccountId);
        expect(newAccountKeyPair).toBeTruthy();
        const expectedAccount = {
            nonce: 0,
            account_id: newAccountId,
            amount: 1,
            code_hash: newAccountCodeHash,
            stake: 0,
        };
        expect(viewAccountResponse).toEqual(expectedAccount);
        expect(deps.storage.getItem(storageAccountIdKey)).toEqual(newAccountId);
    });

    test('test dev connect with invalid account in storage creates a new account', async () => {
        // set up invalid account id in local storage
        deps.storage.setItem(storageAccountIdKey, await generateUniqueString('invalid'));
        await dev.connect(options);
        expect(Object.keys(deps.keyStore.keys).length).toEqual(2);
        const newAccountId = deps.storage.getItem(storageAccountIdKey);
        const viewAccountResponse = await account.viewAccount(newAccountId);
        const newAccountKeyPair = await deps.keyStore.getKey(newAccountId);
        expect(newAccountKeyPair).toBeTruthy();
        const expectedAccount = {
            nonce: 0,
            account_id: newAccountId,
            amount: 1,
            code_hash: newAccountCodeHash,
            stake: 0,
        };
        expect(viewAccountResponse).toEqual(expectedAccount);
        expect(deps.storage.getItem(storageAccountIdKey)).toEqual(newAccountId);
    });

    test('test dev connect with valid account but no keys', async () => {
        // setup: connect with dev, but rmemove keys afterwards!
        deps.storage.setItem(storageAccountIdKey, await generateUniqueString('invalid'));
        await dev.connect(options);
        expect(Object.keys(deps.keyStore.keys).length).toEqual(2);
        const newAccountId = deps.storage.getItem(storageAccountIdKey);
        expect(deps.storage.getItem(storageAccountIdKey)).toEqual(newAccountId);
        await deps.keyStore.clear();
        await dev.connect(options);
        // we are expecting account to be recreated!
        expect(deps.storage.getItem(storageAccountIdKey)).not.toEqual(newAccountId);
    });
});

test('view pre-defined account works and returns correct name', async () => {
    // We do not want to check the other properties of this account since we create other accounts
    // using this account as the originator
    const viewAccountResponse = await account.viewAccount(aliceAccountName);
    expect(viewAccountResponse.account_id).toEqual(aliceAccountName);
});

test('create account and then view account returns the created account', async () => {
    const newAccountName = await generateUniqueString('create.account.test');
    const newAccountPublicKey = '9AhWenZ3JddamBoyMqnTbp7yVbRuvqAv3zwfrWgfVRJE';
    const createAccountResponse = await account.createAccount(newAccountName, newAccountPublicKey, 1, aliceAccountName);
    await nearjs.waitForTransactionResult(createAccountResponse);
    const expectedAccount = {
        nonce: 0,
        account_id: newAccountName,
        amount: 1,
        code_hash: newAccountCodeHash,
        stake: 0,
    };
    const result = await account.viewAccount(newAccountName);
    expect(result).toEqual(expectedAccount);
});

test('create account with a new key and then view account returns the created account', async () => {
    const newAccountName = await generateUniqueString('create.randomkey.test');
    const amount = 2;
    const aliceAccountBeforeCreation = await account.viewAccount(aliceAccountName);
    const createAccountResponse = await account.createAccountWithRandomKey(
        newAccountName,
        amount,
        aliceAccountName);
    await nearjs.waitForTransactionResult(createAccountResponse);
    expect(createAccountResponse['key']).not.toBeFalsy();
    const expectedAccount = {
        nonce: 0,
        account_id: newAccountName,
        amount: amount,
        code_hash: newAccountCodeHash,
        stake: 0,
    };
    const result = await account.viewAccount(newAccountName);
    expect(result).toEqual(expectedAccount);
    const aliceAccountAfterCreation = await account.viewAccount(aliceAccountName);
    expect(aliceAccountAfterCreation.amount).toBe(aliceAccountBeforeCreation.amount - amount);
});

describe('with deployed contract', () => {
    let contract;
    let oldLog;
    let logs;
    let contractName = 'test_contract_' + Date.now();

    beforeAll(async () => {
        // See README.md for details about this contract source code location.
        const keyWithRandomSeed = await KeyPair.fromRandomSeed();
        const createAccountResponse = await account.createAccount(
            contractName,
            keyWithRandomSeed.getPublicKey(),
            10,
            aliceAccountName);
        await nearjs.waitForTransactionResult(createAccountResponse);
        keyStore.setKey(contractName, keyWithRandomSeed);
        const data = [...fs.readFileSync('../tests/hello.wasm')];
        await nearjs.waitForTransactionResult(
            await nearjs.deployContract(contractName, data));
        contract = await nearjs.loadContract(contractName, {
            sender: aliceAccountName,
            viewMethods: ['getAllKeys', "returnHiWithLogs"],
            changeMethods: ['generateLogs', 'triggerAssert', 'testSetRemove']
        });
    });

    beforeEach(async () => {
        oldLog = console.log;
        logs = [];
        console.log = function() {
            logs.push(Array.from(arguments).join(' '));
        };
    });

    afterEach(async () => {
        console.log = oldLog;
    });

    test('make function calls raw', async () => {
        const viewFunctionResult = await nearjs.callViewFunction(
            contractName,
            'hello', // this is the function defined in hello.wasm file that we are calling
            { name: 'trex' });
        expect(viewFunctionResult).toEqual('hello trex');

        const setCallValue = await generateUniqueString('setCallPrefix');
        const scheduleResult = await nearjs.scheduleFunctionCall(
            0,
            aliceAccountName,
            contractName,
            'setValue', // this is the function defined in hello.wasm file that we are calling
            { value: setCallValue });
        expect(scheduleResult.hash).not.toBeFalsy();
        await nearjs.waitForTransactionResult(scheduleResult);
        const getValueResult = await nearjs.callViewFunction(
            contractName,
            'getValue', // this is the function defined in hello.wasm file that we are calling
            {});
        expect(getValueResult).toEqual(setCallValue);
    });

    test('make function calls wrapped', async () => {
        // test that load contract works and we can make calls afterwards
        const contract = await nearjs.loadContract(contractName, {
            viewMethods: ['hello', 'getValue'],
            changeMethods: ['setValue'],
            sender: aliceAccountName,
        });
        const helloResult = await contract.hello({ name: 'trex' });
        expect(helloResult).toEqual('hello trex');
        const setCallValue2 = await generateUniqueString('setCallPrefix');
        const setValueResult = await contract.setValue({ value: setCallValue2 });
        expect(setValueResult.status).toBe('Completed');
        const getValueResult2 = await contract.getValue();
        expect(getValueResult2).toEqual(setCallValue2);
    });

    test('can get logs from method result', async () => {
        await contract.generateLogs();
        expect(logs).toEqual([`[${contractName}]: LOG: log1`, `[${contractName}]: LOG: log2`]);
    });

    test('can get logs from view call', async () => {
        let result = await contract.returnHiWithLogs();
        expect(result).toEqual('Hi');
        expect(logs).toEqual([`[${contractName}]: LOG: loooog1`, `[${contractName}]: LOG: loooog2`]);
    });

    test('can get assert message from method result', async () => {
        await expect(contract.triggerAssert()).rejects.toThrow(/Transaction .+ failed.+expected to fail/);
        expect(logs.length).toBe(3);
        expect(logs[0]).toEqual(`[${contractName}]: LOG: log before assert`);
        expect(logs[1]).toMatch(new RegExp(`^\\[${contractName}\\]: ABORT: "expected to fail" filename: "main.ts" line: \\d+ col: \\d+$`));
        expect(logs[2]).toEqual(`[${contractName}]: Runtime error: wasm async call execution failed with error: Wasmer(CallError(Runtime(User { msg: "Error: AssertFailed" })))`);
    });

    test('test set/remove', async () => {
        const result = await contract.testSetRemove({value: '123'});
        expect(result.status).toBe('Completed');
    });
});

// Generate some unique string with a given prefix using the alice nonce.
const generateUniqueString = async (prefix) => {
    const viewAccountResponse = await account.viewAccount(aliceAccountName);
    return prefix + viewAccountResponse.nonce;
};