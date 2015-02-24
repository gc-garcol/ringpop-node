// Copyright (c) 2015 Uber Technologies, Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
// THE SOFTWARE.
'use strict';

var after = require('after');
var test = require('tape');

var allocCluster = require('../lib/alloc-cluster.js');

var retrySchedule = [0, 0.01, 0.02];

test('can proxyReq() to someone', function t(assert) {
    var cluster = allocCluster(function onReady() {
        var keyOne = cluster.keys.one;
        var keyTwo = cluster.keys.two;

        assert.equal(cluster.one.handleOrProxy(keyOne), true);

        cluster.request({
            key: keyTwo,
            host: 'one',
            json: { hello: true }
        }, function onResponse(err, resp) {
            assert.ifError(err);

            assert.equal(resp.statusCode, 200);
            assert.equal(resp.body.host, 'two');
            assert.equal(resp.body.payload.hello, true);

            cluster.destroy();
            assert.end();
        });
    });
});

test('one retry', function t(assert) {
    assert.plan(6);

    var ringpopOpts = {
        requestProxyMaxRetries: 3,
        requestProxyRetrySchedule: retrySchedule
    };

    var cluster = allocCluster(ringpopOpts, function onReady() {
        cluster.two.membership.checksum = cluster.one.membership.checksum + 1;

        cluster.two.once('requestProxy.checksumsDiffer', function onBadChecksum() {
            assert.pass('received request with invalid checksum');
            cluster.two.membership.checksum = cluster.one.membership.checksum;
        });

        cluster.two.once('request', function onGoodChecksum() {
            assert.pass('received subsequent request with valid checksum');
        });

        cluster.request({
            key: cluster.keys.two,
            host: 'one',
            json: { hello: true }
        }, function onResponse(err, resp) {
            assert.ifErr(err);

            assert.equal(resp.statusCode, 200);
            assert.equal(resp.body.host, 'two');
            assert.equal(resp.body.payload.hello, true);

            cluster.destroy();
            assert.end();
        });
    });
});

test('two retries', function t(assert) {
    assert.plan(9);

    var ringpopOpts = {
        requestProxyMaxRetries: 3,
        requestProxyRetrySchedule: retrySchedule
    };
    var numAttempts = 0;

    var cluster = allocCluster(ringpopOpts, function onReady() {
        cluster.two.membership.checksum = cluster.one.membership.checksum + 1;

        cluster.two.on('requestProxy.checksumsDiffer', function onBadChecksum() {
            numAttempts++;

            // If last retry
            if (numAttempts === cluster.two.requestProxy.maxRetries) {
                cluster.two.membership.checksum = cluster.one.membership.checksum;
            }

            assert.pass('received request with invalid checksum');
        });

        cluster.two.once('request', function onGoodChecksum() {
            numAttempts++;
            assert.pass('received request with valid checksum on last retry');
        });

        cluster.request({
            key: cluster.keys.two,
            host: 'one',
            json: { hello: true }
        }, function onResponse(err, resp) {
            assert.ifErr(err);

            assert.equal(resp.statusCode, 200);
            assert.equal(resp.body.host, 'two');
            assert.equal(resp.body.payload.hello, true);

            assert.equal(numAttempts, cluster.two.requestProxy.maxRetries + 1);

            cluster.destroy();
            assert.end();
        });
    });
});

test('no retries, invalid checksum', function t(assert) {
    assert.plan(4);

    var numAttempts = 0;
    var ringpopOpts = {
        requestProxyMaxRetries: 0
    };

    var cluster = allocCluster(ringpopOpts, function onReady() {
        cluster.two.membership.checksum = cluster.one.membership.checksum + 1;

        cluster.two.on('requestProxy.checksumsDiffer', function onBadChecksum() {
            numAttempts++;
            assert.pass('received request with invalid checksum');
        });

        cluster.two.once('request', function onGoodChecksum() {
            numAttempts++;
            assert.fail('never emits a request event');
        });

        cluster.request({
            key: cluster.keys.two,
            host: 'one',
            json: { hello: true }
        }, function onResponse(err, resp) {
            assert.ifErr(err);

            assert.equal(resp.statusCode, 500);
            assert.equal(numAttempts, 1, 'only 1 attempt because no retries');

            cluster.destroy();
            assert.end();
        });
    });
});

test('exceeds max retries, errors out', function t(assert) {
    assert.plan(9);

    var numAttempts = 0;
    var ringpopOpts = {
        requestProxyMaxRetries: 5,
        requestProxyRetrySchedule: retrySchedule
    };

    var cluster = allocCluster(ringpopOpts, function onReady() {
        cluster.two.membership.checksum = cluster.one.membership.checksum + 1;

        cluster.two.on('requestProxy.checksumsDiffer', function onBadChecksum() {
            numAttempts++;
            assert.pass('received request with invalid checksum');
        });

        cluster.two.once('request', function onGoodChecksum() {
            numAttempts++;
            assert.fail('never emits a request event');
        });

        cluster.request({
            key: cluster.keys.two,
            host: 'one',
            json: { hello: true }
        }, function onResponse(err, resp) {
            assert.ifErr(err);

            assert.equal(resp.statusCode, 500);
            assert.equal(numAttempts, ringpopOpts.requestProxyMaxRetries + 1, '1 initial send + maxRetries');

            cluster.destroy();
            assert.end();
        });
    });
});

test('removes timeout timers', function t(assert) {
    var numRequests = 3;

    var done = after(numRequests, function onDone() {
        var beforeDestroy = cluster.one.requestProxy.retryTimeouts.length;
        assert.equal(beforeDestroy, numRequests, 'timers are pending');

        cluster.destroy();

        var afterDestroy = cluster.one.requestProxy.retryTimeouts.length;
        assert.equal(afterDestroy, 0, 'timers are cleared');

        assert.end();
    });

    var ringpopOpts = {
        // Really really long delays before retry is initiated
        requestProxyRetrySchedule: [100000, 200000, 300000]
    };

    var cluster = allocCluster(ringpopOpts, function onReady() {
        cluster.two.membership.checksum = cluster.one.membership.checksum + 1;

        cluster.one.on('requestProxy.retryScheduled', function onRetry() {
            done();
        });

        function onRequest() {
            assert.fail('no response');
        }

        for (var i = 0; i < numRequests; i++) {
            cluster.request({
                key: cluster.keys.two,
                host: 'one',
                json: { hello: true }
            }, onRequest);
        }
    });
});

test('removes some timeouts, not others', function t(assert) {
    var ringpopOpts = {
        // Really really long delays before retry is initiated
        requestProxyRetrySchedule: [100000, 200000, 300000]
    };

    var cluster = allocCluster(ringpopOpts, function onReady() {
        cluster.two.membership.checksum = cluster.one.membership.checksum + 1;

        // Only one retry will be attempted, others will still be waiting
        cluster.one.on('requestProxy.retryAttempted', function onRetry() {
            cluster.two.membership.checksum = cluster.one.membership.checksum;
        });

        for (var i = 0; i < 2; i++) {
            cluster.request({
                key: cluster.keys.two,
                host: 'one',
                json: { hello: true }
            }, assert.fail);
        }

        cluster.request({
            key: cluster.keys.two,
            host: 'one',
            json: { hello: true },
            retrySchedule: [0]
        }, function onRequest() {
            var beforeDestroy = cluster.one.requestProxy.retryTimeouts.length;
            assert.equal(beforeDestroy, 2, 'timers are pending');

            cluster.destroy();

            assert.end();
        });
    });
});
