import { registerRootComponent } from 'expo';

// Define the background location task at module scope so the OS can invoke
// it while the app is backgrounded or the screen is locked.
import './src/locationTask';

import App from './App';

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App);
