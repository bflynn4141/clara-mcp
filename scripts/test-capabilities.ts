import { initProviders, getProviderRegistry, shutdownProviders } from '../src/providers/index.js';

async function test() {
  console.log('Initializing providers...');
  await initProviders();
  
  const registry = getProviderRegistry();
  
  console.log('\n📊 Available Capabilities:');
  console.log('  ContractMetadata (ethereum):', registry.hasCapability('ContractMetadata', 'ethereum'));
  console.log('  ContractMetadata (base):', registry.hasCapability('ContractMetadata', 'base'));
  console.log('  TxAnalysis (ethereum):', registry.hasCapability('TxAnalysis', 'ethereum'));
  console.log('  HistoryList (ethereum):', registry.hasCapability('HistoryList', 'ethereum'));
  
  console.log('\n📋 Registered Providers:');
  console.log(JSON.stringify(registry.getRegisteredProviders(), null, 2));
  
  await shutdownProviders();
}

test().catch(console.error);
