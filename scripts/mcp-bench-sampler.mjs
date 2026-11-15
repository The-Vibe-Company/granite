// Loaded only by the benchmark child; no production instrumentation.
process.on('message', id => process.send?.({ id, time: performance.now(), memory: process.memoryUsage(), cpu: process.cpuUsage() }));
setInterval(() => process.send?.({ memory: process.memoryUsage(), cpu: process.cpuUsage() }), 100).unref();
