#!/usr/bin/env node

/////// Required environment variables:

// APP_NAME - application name (e.g. 'docs')
// APP_ID - application ID unique within application name (e.g. '1')
// COREOS_HOST - IP or hostname of the VM the Docker container is running on
// IMAGE - the Docker image this container is running

/////// Optional environment variables:

// APP_HEALTH_URL = URL path that must respond with HTTP 200 for the sevice to be healthy
// APP_PORT - the TCP port the application listens on within the container; if not provided,
//            the foreman will not wait for the Docker port mapping

/////// Required command line parameters: 

// The command and arguments to start the backend, e.g.
// auth0-foreman node server.js
// (This would be typically specifified in Dockerfile)

// Validate environment

var assert = require('assert');

var options = {};
['APP_NAME', 'APP_ID', 'COREOS_HOST', 'IMAGE']
    .forEach(function (v) { 
        assert.ok(process.env[v] !== undefined, v + ' environment variable not set.'); 
        options[v.toLowerCase()] = process.env[v];
    });

// Test URL path is optional

options.app_health_url = process.env.APP_HEALTH_URL;
options.app_port = process.env.APP_PORT;

// Obtain command and arguments to start the backend

process.argv.shift();
process.argv.shift();
options.backend_cmd = process.argv.shift();
options.backend_args = process.argv;
assert.ok(options.backend_cmd, 'The command and arguments to start the backend must be specified as command line parameters.');

// Establish the mechanism the server will use to signal the foreman. Allowed values are 'stdout' or 'file'.

process.env.SIGNAL_METHOD = options.signal_method = 
    process.env.SIGNAL_METHOD || 'file'; 
assert.ok(options.signal_method === 'file' || options.signal_method === 'stdout', 
    'SIGNAL_METHOD environment variable must be either `file` or `stdout`.');

// Establish signal file name to allow the backend to signal readiness. This is only
// used when SIGNAL_METHOD === 'file'

process.env.SIGNAL_FILE = options.signal_file = 
    process.env.SIGNAL_FILE || '/data/backend_signal';

var async = require('async')
    , fs = require('fs')
    , spawn = require('child_process').spawn
    , http = require('http')
    , winston = require('winston')
    , host = process.env.COREOS_HOST || '127.0.0.1'
    , etcd = new (require('node-etcd'))(host)
    , docker = new (require('dockerode'))({ host: host, port: 2375 })
    , coreos_tools = require('../lib/index');

// Container name and config path.
var container_name = options.app_name + '-' + options.app_id;
var config_path = '/routes/' + options.app_name + '/' + options.app_id;
var target_port = options.app_port + '/tcp';
var container = docker.getContainer(container_name); 

var route;
var route_timer;
var config;
var config_created;
var backend;

// Register to clean up on process exit
process.on('uncaughtException', function (e) {
    winston.error('Foreman: Uncaught exception', e.stack || e);
    last_resort_cleanup();
});
process.on('exit', last_resort_cleanup);

async.series([
    function (callback) {
        // Get etcd config
        coreos_tools.etcd_get('/config', function (error, result) {
            winston.info('Foreman: Obtained config', error, config);
            config = result;
            callback(error);
        });
    },
    function (callback) {
        // Etablish signal file and watch it, then start the backend
        // and wait for it to signal back, or for the startup timer to expire.

        // Add ETCD config to environment
        process.env.JSON_CONFIG = JSON.stringify(coreos_tools.upper(config));

        var watch;
        if (options.signal_method === 'file') {
            // Wait for changes to the SIGNAL_FILE made by the server
            fs.writeFileSync(options.signal_file, '');
            watch = fs.watch(options.signal_file, { persistent: false });
            watch.once('change', function () { done('signal'); });
        }
        else { // 'stdout'
            // Wait for the server to write LISTENING to stdout
            process.stdout.setEncoding('utf8');
            process.stdout.on('data', stdout_listener);
        }

        if (options.backend_cmd.indexOf('docker') !== -1)
            process.env.LD_LIBRARY_PATH = '/data/lib64';
        backend = spawn(options.backend_cmd, options.backend_args, { 
            env: process.env,
            stdio: 'inherit'
        });

        backend.once('exit', function () { done('exit'); });
        backend.once('error', function () { done('exit'); });
        var timeout = setTimeout(function () { 
            done('timeout'); 
        }, +config.container_registration_timeout * 1000);

        function stdout_listener(data) {
            if (data.indexOf('LISTENING') >= 0)
                done('signal');
        }

        var done_reason;
        function done(reason) {
            winston.info('Foreman: Finished waiting for component to startup', reason);
            if (done_reason) return;
            done_reason = reason;
            backend.removeAllListeners();
            if (options.signal_method === 'file') 
                watch.removeAllListeners();
            else
                process.stdout.removeListener(stdout_listener);
            if (done_reason !== 'timeout') 
                clearTimeout(timeout);
            if (reason === 'exit')
                callback(new Error('Backend process terminated unexpectedly during startup.'));
            else { 
                // Timeout may indicate backend that does not know how to signal, 
                // so assume innocence for now.

                // Register to detect backend's exit going forward:
                backend.once('exit', backend_exited);
                backend.once('error', backend_exited);

                callback(); 
            }
        }
    },
    function (callback) {
        // Wait for the docker port mapping if requested
        if (!options.app_port) {
            route = 'default';
            return callback();
        }

        var attempts = +config.docker_port_registration_retry_count;
        var delay = +config.docker_port_registration_retry_delay;
        var backoff = +config.docker_port_registration_retry_backoff;
        async.doUntil(
            function (callback) {
                // Check if docker container port had been mapped.
                container.inspect(function (error, info) {
                    winston.info('Foreman: Waiting for Docker port mapping', attempts, error)
                    if (error)
                        return callback(error);
                    attempts--;
                    delay *= Math.floor(delay * backoff);
                    if (info.NetworkSettings
                        && typeof info.NetworkSettings.Ports === 'object'
                        && Array.isArray(info.NetworkSettings.Ports[target_port])
                        && info.NetworkSettings.Ports[target_port].length === 1
                        && info.NetworkSettings.Ports[target_port][0].HostPort) 
                            route = info.NetworkSettings.Ports[target_port][0].HostPort;
                    if (route)
                        callback();
                    else if (attempts === 0)
                        callback(new Error('Timeout waiting for the container ' 
                            + container_name + ' to establish a port mapping.'));
                    else 
                        setTimeout(callback, delay);
                });
            },
            function () {
                // Stop querying docker for port mapping only when mapped.
                return route !== undefined;
            },
            callback);
    },
    function (callback) {
        winston.info('Foreman: Establishd port mapping', route);
        // Send the test HTTP GET request to validate the backend
        if (!options.app_health_url)
            return callback();

        var url = 'http://' + options.coreos_host + ':' + route + options.app_health_url;
        winston.info('Foreman: Probing health endpoint', url);
        http.get({
            agent: false, // don't use keep-alive which prevents server from closing down
            host: options.coreos_host,
            port: route,
            path: options.app_health_url
        }, function (res) {
            winston.info('Foreman: Health endpoint response', res.statusCode);
            callback(res.statusCode === 200 
                ? undefined 
                : new Error('Backend did not respond to health check at ' 
                    + url + ' with status code 200: ' + res.statusCode))
        }).on('error', function (error) {
            winston.error('Foreman: Health endpoint error', error);
            callback(new Error('Backend failed to respond to health check at ' + url));
        });
    },
    function (callback) {
        // Register static metadata in etcd
        config_created = true;
        async.parallel([
            function (callback) {
                etcd.set(config_path + '/created', Date.now(), callback);
            },
            function (callback) {
                etcd.set(config_path + '/image', options.image, callback);
            },
            function (callback) {
                etcd.set(config_path + '/host', options.coreos_host, callback);
            }
        ], callback);
    },
    function (callback) {
        winston.info('Foreman: Created routing entry in etcd')
        // Keep container route registration in etcd current with a TTL
        var route_config_path = config_path + '/port';
        async.forever(
            function (next) {
                etcd.set(route_config_path, route, { ttl: 60 }, function (error) {
                    if (error) return next(error);
                    route_timer = setTimeout(next, 45000);
                });
            }, 
            function (error) { 
                winston.error('Foreman: Error updating route entry in etcd', error);
                recycle('SIGTERM', 105); 
            });

        // Detect externally initiated graceful termintion of the container
        process
            .once('SIGTERM', function () { recycle('SIGTERM', 0); })
            .once('SIGINT', function () { recycle('SIGINT', 0); });

        function recycle(signal, exitCode) {
            winston.info('Foreman: Recycling', signal, exitCode);
            if (backend)
                backend.graceful_exit_code = exitCode;

            // Remove etcd registration
            if (route_timer) {
                clearTimeout(route_timer);
                route_timer = undefined;
            }

            async.series([
                function (callback) {
                    // Mark the container as recycling in etcd
                    etcd.set(config_path + '/recycling', Date.now(), callback);
                },
                function (callback) {
                    // Remove routing information from etcd
                    etcd.del(config_path + '/port', callback);
                },
                function (callback) {
                    // Gracefully stop the server after cooldown timeout
                    setTimeout(function () {
                        winston.info('Foreman: Cooldown time elapsed, sending SIGTERM to backend', backend !== undefined);
                        if (backend)
                            backend.kill(signal);
                    }, +config.cooldown_timeout * 1000);
                    winston.info('Foreman: Initiated cooldown timer', +config.cooldown_timeout);

                    // Let active requests complete up to the graceful shutdown timeout
                    setTimeout(function () {
                        winston.info('Foreman: Graceful shutdown time elapsed, exiting foreman');
                        last_resort_cleanup();
                        process.exit(exitCode);
                    }, +config.graceful_shutdown_timeout * 1000);
                    winston.info('Foreman: Initiated graceful shutdown timer', +config.graceful_shutdown_timeout);
                }
            ], callback);
        }
    }
], function (error) {
    winston.error('Foreman: Foreman error', error);
    last_resort_cleanup();
    throw error;
});

function backend_exited(code) {
    winston.info('Foreman: Backend exited', code);
    assert.ok(backend);
    
    backend.removeAllListeners();
    var graceful_exit_code = backend.graceful_exit_code;
    backend = undefined;

    if (route_timer) {
        clearTimeout(route_timer);
        route_timer = undefined;
    }

    etcd.del(config_path, { recursive: true }, function () {
        winston.info('Foreman: Deleted routing entry in etcd', config_path);
        process.exit(graceful_exit_code !== undefined ? graceful_exit_code : code);
    });
}

function last_resort_cleanup() {
    winston.info('Foreman: Last resort cleanup started');
    if (backend) {
        winston.info('Foreman: Last resort cleanup: killing backend');
        backend.removeAllListeners();
        try { backend.kill('SIGKILL'); } catch(e) {}
        backend = undefined;
    }

    if (route_timer) {
        winston.info('Foreman: Last resort cleanup: stopping route update timer');
        clearTimeout(route_timer);
        route_timer = undefined;
    }

    if (config_created) {
        winston.info('Foreman: Last resort cleanup: removing routing entry in etcd');
        etcd.del(config_path, { recursive: true });
        config_created = undefined;
    }
}
