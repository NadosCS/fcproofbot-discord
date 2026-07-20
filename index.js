/**
 * Root launcher for hosting panels that always start /home/container/index.js.
 *
 * The actual bot entry file remains src/index.js.
 */
import('./src/index.js').catch((error) => {
  console.error('Failed to start the FC Proof bot:', error);
  process.exitCode = 1;
});
