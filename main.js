'use strict';
var CryptoJS = require('crypto-js');
var express = require('express');
var bodyParser = require('body-parser');
var WebSocket = require('ws');
const { MerkleTree } = require('merkletreejs');
const SHA256 = require('crypto-js/sha256');

var http_port = process.env.HTTP_PORT || 3001;
var p2p_port = process.env.P2P_PORT || 6001;
var initialPeers = process.env.PEERS ? process.env.PEERS.split(',') : [];

class Block {
    constructor(index, previousHash, timestamp, data, hash, merkleHash) {
        this.index = index;
        this.previousHash = previousHash.toString();
        this.timestamp = timestamp;
        this.data = data;
        this.hash = hash.toString();
        this.merkleHash = merkleHash.toString();
    }
}

var sockets = [];
var MessageType = {
    QUERY_LATEST: 0,
    QUERY_ALL: 1,
    RESPONSE_BLOCKCHAIN: 2,
    RESPONSE_LOCAL_MERKLE_ROOT: 3,
    RESPONSE_JOINT_MERKLE_ROOT: 4,
    RESPONSE_PRINT: 5,
    RESPONSE_PRUNE: 6,
};

var getGenesisBlock = () => {
    return new Block(
        0,
        '0',
        1465154705,
        'my genesis block!!',
        '816534932c2b7154836da6afc367695e6337db8a921823784c14378abed4f7d7',
        '816534932c2b7154836da6afc367695e6337db8a921823784c14378abed4f7d7'
    );
};

var blockchain = [getGenesisBlock()];

var localCommitments = [];
var localMerkleTreeMempool = [];

var storedLocalMerkleTrees = [];
var storedJointMerkleTrees = [];

// Prints the stats of the blockchain at the current moment
function printStats() {
    console.log('--------------------------------');
    console.log('Blockchain Length: ' + blockchain.length);
    console.log('Stored JMT Length: ' + storedJointMerkleTrees.length);
    console.log('Stored LMT Length: ' + storedLocalMerkleTrees.length);
    console.log('Local Commitments Length: ' + localCommitments.length);
    console.log(
        'Local Merkle Tree Mempool Length: ' + localMerkleTreeMempool.length
    );
    console.log();

    console.log('Blockchain: ');
    for (const block of blockchain) {
        console.log(
            '-Block',
            block.index,
            // 'with hash,',
            // block.hash,
            'with JMR: ',
            block.merkleHash
        );
    }
    console.log();
    console.log('Stored JMTs: ');
    for (const jmt of storedJointMerkleTrees) {
        console.log('-Tree w/ Root of', jmt.getRoot().toString('hex'));
    }
    console.log();
    console.log('Stored LMTs: ');
    for (const lmt of storedLocalMerkleTrees) {
        console.log('-Tree w/ Root of', lmt.getRoot().toString('hex'));
    }
    console.log();
    console.log('Local Commitments: ', localCommitments);
    console.log();
    console.log('Local Merkle Tree Mempool: ', localMerkleTreeMempool);
    console.log();

    console.log('--------------------------------');
}

// Initializes the HTTP server with an ExpressJS backend
var initHttpServer = () => {
    var app = express();
    app.use(bodyParser.json());

    // Returns the blockchain
    app.get('/blocks', (req, res) => res.send(JSON.stringify(blockchain)));

    // Prints all stats of the blockchain
    app.post('/print', (req, res) => {
        printStats();
        broadcast(printMsg());
        res.send();
    });

    // Prunes each node's local storage of stored JMTs and LMTs
    // (ex. after a day of storing them, we can safely prune them)
    app.post('/prune', (req, res) => {
        storedJointMerkleTrees = [];
        storedLocalMerkleTrees = [];

        broadcast(pruneMsg());
        res.send();
    });

    // Mines the next block of the blockchain by this node.
    // Add any local commitments and LMRs to the JMT
    app.post('/mineBlock', (req, res) => {
        // Add local commitments
        if (localCommitments.length) {
            const tree = new MerkleTree(localCommitments, SHA256);
            localMerkleTreeMempool.push(tree.getRoot().toString('hex'));
            storedLocalMerkleTrees.push(tree);
            localCommitments = [];
        }

        var newBlock = generateNextBlock(req.body.data);

        addBlock(newBlock);

        broadcast(responseLatestMsg());

        // Add local LMRs
        if (localMerkleTreeMempool.length > 0) {
            console.log(localMerkleTreeMempool);
            let jmt = new MerkleTree(localMerkleTreeMempool, SHA256);

            broadcast(responseLatestTreeMsg(localMerkleTreeMempool));

            storedJointMerkleTrees.push(jmt);
            localMerkleTreeMempool = [];
        }

        // console.log('block added: ' + JSON.stringify(newBlock));
        res.send();
    });

    // Broadcast this node's locally generated LMR to the network. Store the LMT until it is pruned.
    app.post('/broadcastLocalMerkleRoot', (req, res) => {
        const tree = new MerkleTree(localCommitments, SHA256);
        storedLocalMerkleTrees.push(tree);
        localCommitments = [];

        let root = tree.getRoot();
        console.log('broadcasted LMR');
        // console.log('Created LMT: ', tree.toString());
        // console.log('Created LMR: ', root.toString('hex'));

        localMerkleTreeMempool.push(root.toString('hex'));

        // console.log('Adding LMR: ', root.toString('hex'));
        // console.log('localMerkleTreeMempool: ', localMerkleTreeMempool);

        broadcast(responseLocalMerkleRoot(root.toString('hex')));

        res.send();
    });

    // Get blockchain peers
    app.get('/peers', (req, res) => {
        res.send(
            sockets.map(
                (s) => s._socket.remoteAddress + ':' + s._socket.remotePort
            )
        );
    });

    // Add a new local commitment. This is triggered by the end-user with their commitment.
    app.post('/addCommitment', (req, res) => {
        localCommitments.push(req.body.data);
        console.log('adding local commitment: ', req.body.data);
        res.send();
    });

    // Start server
    app.listen(http_port, () =>
        console.log('Listening http on port: ' + http_port)
    );
};

// Start P2P Network
var initP2PServer = () => {
    var server = new WebSocket.Server({ port: p2p_port });
    server.on('connection', (ws) => initConnection(ws));
    console.log('listening websocket p2p port on: ' + p2p_port);
};

var initConnection = (ws) => {
    sockets.push(ws);
    initMessageHandler(ws);
    initErrorHandler(ws);
    write(ws, queryChainLengthMsg());
};

// Handle incoming and outgoing messages to and from other nodes, respectively.
var initMessageHandler = (ws) => {
    ws.on('message', (data) => {
        var message = JSON.parse(data);
        // console.log('Received message' + JSON.stringify(message));
        // console.log('Received message: ', message.type);
        switch (message.type) {
            case MessageType.QUERY_LATEST:
                write(ws, responseLatestMsg());
                break;
            case MessageType.QUERY_ALL:
                write(ws, responseChainMsg());
                break;
            case MessageType.RESPONSE_BLOCKCHAIN:
                handleBlockchainResponse(message);
                break;
            case MessageType.RESPONSE_LOCAL_MERKLE_ROOT:
                handleLocalMerkleRootResponse(message);
                break;
            case MessageType.RESPONSE_JOINT_MERKLE_ROOT:
                handleJointMerkleRootResponse(message);
                break;
            case MessageType.RESPONSE_PRINT:
                printStats();
                break;
            case MessageType.RESPONSE_PRUNE:
                storedJointMerkleTrees = [];
                storedLocalMerkleTrees = [];
                break;
        }
    });
};

var initErrorHandler = (ws) => {
    var closeConnection = (ws) => {
        console.log('connection failed to peer: ' + ws.url);
        sockets.splice(sockets.indexOf(ws), 1);
    };
    ws.on('close', () => closeConnection(ws));
    ws.on('error', () => closeConnection(ws));
};

// Generate the next block in the blockchain with a newly generated JMT and JMR
var generateNextBlock = (blockData) => {
    let jmt = new MerkleTree(localMerkleTreeMempool, SHA256);
    let jmr = jmt.getRoot().toString('hex');

    var previousBlock = getLatestBlock();
    var nextIndex = previousBlock.index + 1;
    var nextTimestamp = new Date().getTime() / 1000;
    var nextHash = calculateHash(
        nextIndex,
        previousBlock.hash,
        nextTimestamp,
        blockData
    );
    return new Block(
        nextIndex,
        previousBlock.hash,
        nextTimestamp,
        blockData,
        nextHash,
        jmr
    );
};

//Below are some internal helper functions
var calculateHashForBlock = (block) => {
    return calculateHash(
        block.index,
        block.previousHash,
        block.timestamp,
        block.data
    );
};

var calculateHash = (index, previousHash, timestamp, data) => {
    return CryptoJS.SHA256(index + previousHash + timestamp + data).toString();
};

var addBlock = (newBlock) => {
    if (isValidNewBlock(newBlock, getLatestBlock())) {
        blockchain.push(newBlock);
        console.log('block added');
    }
};

var isValidNewBlock = (newBlock, previousBlock) => {
    if (previousBlock.index + 1 !== newBlock.index) {
        console.log('invalid index');
        return false;
    } else if (previousBlock.hash !== newBlock.previousHash) {
        console.log('invalid previoushash');
        return false;
    } else if (calculateHashForBlock(newBlock) !== newBlock.hash) {
        console.log(
            typeof newBlock.hash + ' ' + typeof calculateHashForBlock(newBlock)
        );
        console.log(
            'invalid hash: ' +
                calculateHashForBlock(newBlock) +
                ' ' +
                newBlock.hash
        );
        return false;
    }
    return true;
};

var connectToPeers = (newPeers) => {
    newPeers.forEach((peer) => {
        var ws = new WebSocket(peer);
        ws.on('open', () => initConnection(ws));
        ws.on('error', () => {
            console.log('connection failed');
        });
    });
};

//Below are the message handler functions based on message type
var handleLocalMerkleRootResponse = (message) => {
    var root = message.data;
    localMerkleTreeMempool.push(root);
    console.log('addding LMR');
    // console.log('adding LMR: ', root);
    // console.log('localMerkleTreeMempool: ', localMerkleTreeMempool);
};

var handleJointMerkleRootResponse = (message) => {
    var tree = message.data;
    let receivedLMRs = JSON.parse(tree);
    let jmt = new MerkleTree(receivedLMRs, SHA256);
    storedJointMerkleTrees.push(jmt);
    console.log('adding JMR');

    for (const lmr of receivedLMRs) {
        console.log(lmr, localMerkleTreeMempool);
        localMerkleTreeMempool = localMerkleTreeMempool.filter(
            (e) => e !== lmr
        );
    }
    console.log(
        'removed LMRs from local mempool; new length: ',
        localMerkleTreeMempool.length
    );

    // console.log('adding JMR: ', tree);
    // console.log('storedJointMerkleTrees: ', storedJointMerkleTrees);
};

var handleBlockchainResponse = (message) => {
    var receivedBlocks = JSON.parse(message.data).sort(
        (b1, b2) => b1.index - b2.index
    );
    var latestBlockReceived = receivedBlocks[receivedBlocks.length - 1];
    var latestBlockHeld = getLatestBlock();
    if (latestBlockReceived.index > latestBlockHeld.index) {
        // console.log(
        //     'blockchain possibly behind. We got: ' +
        //         latestBlockHeld.index +
        //         ' Peer got: ' +
        //         latestBlockReceived.index
        // );
        if (latestBlockHeld.hash === latestBlockReceived.previousHash) {
            // console.log('We can append the received block to our chain');
            addBlock(latestBlockReceived);
            broadcast(responseLatestMsg());
        } else if (receivedBlocks.length === 1) {
            console.log('We have to query the chain from our peer');
            broadcast(queryAllMsg());
        } else {
            console.log(
                'Received blockchain is longer than current blockchain'
            );
            replaceChain(receivedBlocks);
        }
    } else {
        // console.log(
        //     'received blockchain is not longer than current blockchain. Do nothing'
        // );
    }
};

//Handle if the blockchain is different from peers
var replaceChain = (newBlocks) => {
    if (isValidChain(newBlocks) && newBlocks.length > blockchain.length) {
        console.log(
            'Received blockchain is valid. Replacing current blockchain with received blockchain'
        );
        blockchain = newBlocks;
        broadcast(responseLatestMsg());
    } else {
        console.log('Received blockchain invalid');
    }
};

var isValidChain = (blockchainToValidate) => {
    if (
        JSON.stringify(blockchainToValidate[0]) !==
        JSON.stringify(getGenesisBlock())
    ) {
        return false;
    }
    var tempBlocks = [blockchainToValidate[0]];
    for (var i = 1; i < blockchainToValidate.length; i++) {
        if (isValidNewBlock(blockchainToValidate[i], tempBlocks[i - 1])) {
            tempBlocks.push(blockchainToValidate[i]);
        } else {
            return false;
        }
    }
    return true;
};

//Internal helper functions for messages and queries
var getLatestBlock = () => blockchain[blockchain.length - 1];
var queryChainLengthMsg = () => ({ type: MessageType.QUERY_LATEST });
var queryAllMsg = () => ({ type: MessageType.QUERY_ALL });
var responseChainMsg = () => ({
    type: MessageType.RESPONSE_BLOCKCHAIN,
    data: JSON.stringify(blockchain),
});
var responseLatestMsg = () => ({
    type: MessageType.RESPONSE_BLOCKCHAIN,
    data: JSON.stringify([getLatestBlock()]),
});

var printMsg = () => ({
    type: MessageType.RESPONSE_PRINT,
    data: JSON.stringify([getLatestBlock()]),
});

var pruneMsg = () => ({
    type: MessageType.RESPONSE_PRUNE,
    data: JSON.stringify([getLatestBlock()]),
});

var responseLocalMerkleRoot = (root) => ({
    type: MessageType.RESPONSE_LOCAL_MERKLE_ROOT,
    data: root,
});

var responseLatestTreeMsg = (tree) => ({
    type: MessageType.RESPONSE_JOINT_MERKLE_ROOT,
    data: JSON.stringify(tree),
});

var write = (ws, message) => ws.send(JSON.stringify(message));
var broadcast = (message) =>
    sockets.forEach((socket) => write(socket, message));

//Main code that is run when main.js is called
connectToPeers(initialPeers);
initHttpServer();
initP2PServer();
