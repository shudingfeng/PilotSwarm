// ==============================================================================
// PilotSwarm BaseInfra — the Windows workers' data collection rule (Windows
// worker pool only).
//
// The Azure Monitor Agent on every worker VM (win-workers.bicep) sends what
// this rule collects to the main Log Analytics workspace: the System and
// Application event logs' errors and warnings, and basic performance counters.
// The agent also sends its Heartbeat. A Flexible scale set can't be the
// resource of a data collection rule association, so the disk controller
// associates each new VM with this rule before the VM serves, and removes the
// association when it deletes the VM (WIN_WORKER_DCR_ID).
// ==============================================================================

@description('Azure region.')
param location string

@description('Data collection rule name.')
param name string

@description('Resource ID of the main Log Analytics workspace.')
param logAnalyticsWorkspaceId string

resource dataCollectionRule 'Microsoft.Insights/dataCollectionRules@2023-03-11' = {
  name: name
  location: location
  kind: 'Windows'
  properties: {
    description: 'PilotSwarm Windows workers: event log errors and warnings, and performance counters.'
    dataSources: {
      windowsEventLogs: [
        {
          name: 'worker-events'
          streams: [
            'Microsoft-Event'
          ]
          xPathQueries: [
            'System!*[System[(Level=1 or Level=2 or Level=3)]]'
            'Application!*[System[(Level=1 or Level=2 or Level=3)]]'
          ]
        }
      ]
      performanceCounters: [
        {
          name: 'worker-performance'
          streams: [
            'Microsoft-Perf'
          ]
          samplingFrequencyInSeconds: 60
          counterSpecifiers: [
            '\\Processor(_Total)\\% Processor Time'
            '\\Memory\\Available MBytes'
            '\\LogicalDisk(_Total)\\% Free Space'
            '\\LogicalDisk(_Total)\\Free Megabytes'
            '\\Network Interface(*)\\Bytes Total/sec'
          ]
        }
      ]
    }
    destinations: {
      logAnalytics: [
        {
          name: 'main-workspace'
          workspaceResourceId: logAnalyticsWorkspaceId
        }
      ]
    }
    dataFlows: [
      {
        streams: [
          'Microsoft-Event'
          'Microsoft-Perf'
        ]
        destinations: [
          'main-workspace'
        ]
      }
    ]
  }
}

output dataCollectionRuleId string = dataCollectionRule.id
