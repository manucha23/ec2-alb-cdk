import * as cdk from 'aws-cdk-lib';
import { AutoScalingGroup } from 'aws-cdk-lib/aws-autoscaling';
import { LinuxBuildImage, PipelineProject } from 'aws-cdk-lib/aws-codebuild';
import { InstanceTagSet, ServerApplication, ServerDeploymentGroup } from 'aws-cdk-lib/aws-codedeploy';
import { Artifact, Pipeline } from 'aws-cdk-lib/aws-codepipeline';
import { CodeBuildAction, CodeDeployServerDeployAction, GitHubSourceAction } from 'aws-cdk-lib/aws-codepipeline-actions';
import { AmazonLinuxCpuType, AmazonLinuxGeneration, AmazonLinuxImage, Instance, InstanceClass, InstanceSize, InstanceType, IpAddresses, LaunchTemplate, Peer, Port, SecurityGroup, SubnetType, Vpc } from 'aws-cdk-lib/aws-ec2';
import { ApplicationLoadBalancer, TargetGroupBase } from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { ManagedPolicy, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { readFileSync } from 'fs';
// import * as sqs from 'aws-cdk-lib/aws-sqs';

export class Ec2AlbCdkStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
//Create role for EC2
    const webServerRole = new Role(this, "ec2Role", {
      assumedBy: new ServicePrincipal("ec2.amazonaws.com"),
    });
    
    webServerRole.addManagedPolicy(ManagedPolicy.fromAwsManagedPolicyName("AmazonSSMManagedInstanceCore"));

    webServerRole.addManagedPolicy(ManagedPolicy.fromAwsManagedPolicyName("service-role/AmazonEC2RoleforAWSCodeDeploy"))

    //Setup VPC
    const vpc = new Vpc(this, 'main-vpc', {
      availabilityZones: ['ap-south-1a', 'ap-south-1b', 'ap-south-1c'],
      ipAddresses: IpAddresses.cidr('10.0.0.0/16'),
      subnetConfiguration: [
        {
         name: 'sub1',
         subnetType: SubnetType.PUBLIC
        }
      ]
    });

    //Define AMI
    const ami = new AmazonLinuxImage({
      generation: AmazonLinuxGeneration.AMAZON_LINUX_2,
      cpuType: AmazonLinuxCpuType.X86_64
    });

    //Add user data to EC2 to setup java
    const webSGUserData = readFileSync('./assets/configure_amz_linux_java_app.sh','utf-8');
    const userData = cdk.aws_ec2.UserData.forLinux();
    userData.addCommands(webSGUserData);

    //security group
    const ec2WebSg = new SecurityGroup(this, 'template-sg', {
      vpc
    });

    //create launchtemplate
    const javaLaunchTemplate = new LaunchTemplate(this, 'java-launcher', {
      instanceType: InstanceType.of(
        InstanceClass.T3,
        InstanceSize.NANO,
      ),
      machineImage: ami,
      role: webServerRole,
      userData: userData,
      securityGroup: ec2WebSg
    })
    //autoscaling group
    const asg = new AutoScalingGroup(this, 'sprinboot-autoscaler', {
      vpc,
      vpcSubnets: {
        availabilityZones: ['ap-south-1a', 'ap-south-1b', 'ap-south-1c']
      },
      desiredCapacity: 2,
      minCapacity: 2,
      maxCapacity: 5,
      launchTemplate: javaLaunchTemplate
    })

    asg.scaleOnCpuUtilization('scalePolicy', {
      targetUtilizationPercent:40,
      estimatedInstanceWarmup: cdk.Duration.seconds(60)
    })

    //ALB security group
    const albWebSg = new SecurityGroup(this, 'alb-sg', {
      vpc
    });
    ec2WebSg.addIngressRule(albWebSg, Port.tcp(8081));

    //Create loadbalancer
    const springAlb = new ApplicationLoadBalancer(this, 'spring-alb', {
      vpc,
      vpcSubnets: {
        availabilityZones: ['ap-south-1a', 'ap-south-1b', 'ap-south-1c']
      },
      internetFacing: true,
      securityGroup: albWebSg
    });

    const listener = springAlb.addListener('Listener', {
      port: 80
    });
    
    listener.addTargets('spring-asg',{
      port: 8080,
      targets: [asg],
      healthCheck: {
        enabled: true,
        port: '8081',
        path: '/actuator/health'
      }
    });

    //Setup codedeploy pipeline
    const pipeline = new Pipeline(this, 'springboot-web-pipeline', {
      pipelineName: 'java-webapp',
      crossAccountKeys: false
    });

    //Stages
    const sourceStage = pipeline.addStage({
      stageName: 'Source'
    });

    const buildStage = pipeline.addStage({
      stageName: 'Build'
    });

    const deployStage = pipeline.addStage({
      stageName: 'Deploy'
    });

    //Source Action
    const sourceOutput = new Artifact();
    const githubSourceAction = new GitHubSourceAction({
      actionName: 'GithubSource',
      oauthToken: cdk.SecretValue.secretsManager('github-oauth-token'),
      owner: 'manucha23',
      repo: 'aws-springboot-app',
      branch: 'main',
      output: sourceOutput
    });

    sourceStage.addAction(githubSourceAction);

    // Build Action
    const springBootTestProject = new PipelineProject(this, 'springBootTestProject',{
      environment: {
        buildImage: LinuxBuildImage.AMAZON_LINUX_2_5
      }
    });

    const springBootBuildOutput = new Artifact();

    const springBootBuildAction = new CodeBuildAction({
      actionName: 'BuildApp',
      project: springBootTestProject,
      input: sourceOutput,
      outputs: [springBootBuildOutput]
    });

    buildStage.addAction(springBootBuildAction);
    
    // Deploy Actions
    const springBootDeployApplication = new ServerApplication(this,"springboot_deploy_application",{
      applicationName: 'aws-springboot-webApp'
    });

    // Deployment group
    const springBootServerDeploymentGroup = new ServerDeploymentGroup(this,'SpringBootAppDeployGroup',{
      application: springBootDeployApplication,
      deploymentGroupName: 'SpringBootAppDeploymentGroup',
      installAgent: true,
      autoScalingGroups: [asg]
    });

    // Deployment action
    const springBootDeployAction = new CodeDeployServerDeployAction({
      actionName: 'springBootAppDeployment',
      input: springBootBuildOutput,
      deploymentGroup: springBootServerDeploymentGroup,
    });

    deployStage.addAction(springBootDeployAction);
    
  }
}
