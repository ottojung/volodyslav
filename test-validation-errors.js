#!/usr/bin/env node

// Test script to demonstrate the fixed error handling in POST /entries
// This shows that validation errors now return 400 instead of 500

const { spawn } = require('child_process');
const http = require('http');

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function makeRequest(path, method = 'GET', data = null) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: 'localhost',
            port: 8000,
            path: path,
            method: method,
            headers: {
                'Content-Type': 'application/json',
            }
        };

        const req = http.request(options, (res) => {
            let responseData = '';
            res.on('data', (chunk) => {
                responseData += chunk;
            });
            res.on('end', () => {
                resolve({
                    statusCode: res.statusCode,
                    headers: res.headers,
                    body: responseData
                });
            });
        });

        req.on('error', (err) => {
            reject(err);
        });

        if (data) {
            req.write(JSON.stringify(data));
        }
        req.end();
    });
}

async function testValidationErrors() {
    console.log('🧪 Testing POST /api/entries error handling...\n');

    const tests = [
        {
            name: 'Empty rawInput',
            data: { rawInput: '' },
            expectedStatus: 400
        },
        {
            name: 'Missing rawInput',
            data: {},
            expectedStatus: 400
        },
        {
            name: 'Invalid input format',
            data: { rawInput: '123invalid' },
            expectedStatus: 400
        },
        {
            name: 'Valid input (should work)',
            data: { rawInput: 'test [loc home] This is a test entry' },
            expectedStatus: 201
        }
    ];

    for (const test of tests) {
        try {
            console.log(`Testing: ${test.name}`);
            const response = await makeRequest('/api/entries', 'POST', test.data);
            
            const success = response.statusCode === test.expectedStatus;
            const status = success ? '✅' : '❌';
            
            console.log(`${status} Expected ${test.expectedStatus}, got ${response.statusCode}`);
            
            if (response.body) {
                try {
                    const parsed = JSON.parse(response.body);
                    if (parsed.error) {
                        console.log(`   Error message: ${parsed.error}`);
                    } else if (parsed.success) {
                        console.log(`   Entry created successfully`);
                    }
                } catch (e) {
                    console.log(`   Raw response: ${response.body.substring(0, 100)}...`);
                }
            }
            console.log('');
        } catch (error) {
            console.log(`❌ Request failed: ${error.message}\n`);
        }
    }
}

async function main() {
    console.log('Starting server...');
    
    // Start the server
    const server = spawn('node', ['/workspace/backend/src/index.js'], {
        stdio: 'pipe',
        env: { ...process.env, NODE_ENV: 'development' }
    });

    // Wait for server to start
    await sleep(2000);

    try {
        await testValidationErrors();
    } catch (error) {
        console.error('Test failed:', error);
    } finally {
        console.log('Stopping server...');
        server.kill();
    }
}

if (require.main === module) {
    main().catch(console.error);
}
