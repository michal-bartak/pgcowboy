export namespace model {
	
	export class AppVersion {
	    version: string;
	    commit: string;
	    buildDate: string;
	    repoURL: string;
	    docsURL: string;
	
	    static createFrom(source: any = {}) {
	        return new AppVersion(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.version = source["version"];
	        this.commit = source["commit"];
	        this.buildDate = source["buildDate"];
	        this.repoURL = source["repoURL"];
	        this.docsURL = source["docsURL"];
	    }
	}
	export class AuthContext {
	    user: string;
	    password: string;
	
	    static createFrom(source: any = {}) {
	        return new AuthContext(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.user = source["user"];
	        this.password = source["password"];
	    }
	}
	export class BatchSettings {
	    maxConcurrency: number;
	
	    static createFrom(source: any = {}) {
	        return new BatchSettings(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.maxConcurrency = source["maxConcurrency"];
	    }
	}
	export class Category {
	    id: string;
	    label: string;
	    color?: string;
	    confirm?: boolean;
	
	    static createFrom(source: any = {}) {
	        return new Category(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.label = source["label"];
	        this.color = source["color"];
	        this.confirm = source["confirm"];
	    }
	}
	export class CategoryInput {
	    label: string;
	    color: string;
	    confirm: boolean;
	
	    static createFrom(source: any = {}) {
	        return new CategoryInput(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.label = source["label"];
	        this.color = source["color"];
	        this.confirm = source["confirm"];
	    }
	}
	export class ChangePasswordParams {
	    loginName: string;
	    newPassword: string;
	
	    static createFrom(source: any = {}) {
	        return new ChangePasswordParams(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.loginName = source["loginName"];
	        this.newPassword = source["newPassword"];
	    }
	}
	export class Cluster {
	    id: string;
	    alias: string;
	    host: string;
	    port: number;
	    database: string;
	    category: string;
	    sslmode?: string;
	    connectUser?: string;
	    password?: string;
	
	    static createFrom(source: any = {}) {
	        return new Cluster(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.alias = source["alias"];
	        this.host = source["host"];
	        this.port = source["port"];
	        this.database = source["database"];
	        this.category = source["category"];
	        this.sslmode = source["sslmode"];
	        this.connectUser = source["connectUser"];
	        this.password = source["password"];
	    }
	}
	export class ClusterInput {
	    alias: string;
	    host: string;
	    port: number;
	    database: string;
	    category: string;
	    sslMode: string;
	    connectUser: string;
	    password: string;
	
	    static createFrom(source: any = {}) {
	        return new ClusterInput(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.alias = source["alias"];
	        this.host = source["host"];
	        this.port = source["port"];
	        this.database = source["database"];
	        this.category = source["category"];
	        this.sslMode = source["sslMode"];
	        this.connectUser = source["connectUser"];
	        this.password = source["password"];
	    }
	}
	export class ResetConfigParams {
	    loginName: string;
	    configName: string;
	
	    static createFrom(source: any = {}) {
	        return new ResetConfigParams(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.loginName = source["loginName"];
	        this.configName = source["configName"];
	    }
	}
	export class SetConfigParams {
	    loginName: string;
	    configName: string;
	    configValue: string;
	
	    static createFrom(source: any = {}) {
	        return new SetConfigParams(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.loginName = source["loginName"];
	        this.configName = source["configName"];
	        this.configValue = source["configValue"];
	    }
	}
	export class SetAttributeParams {
	    loginName: string;
	    attribute: string;
	
	    static createFrom(source: any = {}) {
	        return new SetAttributeParams(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.loginName = source["loginName"];
	        this.attribute = source["attribute"];
	    }
	}
	export class SetCommentParams {
	    loginName: string;
	    comment: string;
	    commentFields?: Record<string, string>;
	
	    static createFrom(source: any = {}) {
	        return new SetCommentParams(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.loginName = source["loginName"];
	        this.comment = source["comment"];
	        this.commentFields = source["commentFields"];
	    }
	}
	export class RevokeParentsParams {
	    loginName: string;
	    parentRoles: string;
	
	    static createFrom(source: any = {}) {
	        return new RevokeParentsParams(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.loginName = source["loginName"];
	        this.parentRoles = source["parentRoles"];
	    }
	}
	export class GrantParentsParams {
	    loginName: string;
	    parentRoles: string;
	
	    static createFrom(source: any = {}) {
	        return new GrantParentsParams(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.loginName = source["loginName"];
	        this.parentRoles = source["parentRoles"];
	    }
	}
	export class RenameRoleParams {
	    loginName: string;
	    newLoginName: string;
	
	    static createFrom(source: any = {}) {
	        return new RenameRoleParams(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.loginName = source["loginName"];
	        this.newLoginName = source["newLoginName"];
	    }
	}
	export class RemoveRoleParams {
	    loginName: string;
	
	    static createFrom(source: any = {}) {
	        return new RemoveRoleParams(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.loginName = source["loginName"];
	    }
	}
	export class CreateRoleParams {
	    loginName: string;
	    parentRoles: string;
	    commentFields?: Record<string, string>;
	
	    static createFrom(source: any = {}) {
	        return new CreateRoleParams(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.loginName = source["loginName"];
	        this.parentRoles = source["parentRoles"];
	        this.commentFields = source["commentFields"];
	    }
	}
	export class OperationSpec {
	    operation: string;
	    createRole?: CreateRoleParams;
	    removeRole?: RemoveRoleParams;
	    renameRole?: RenameRoleParams;
	    grantParents?: GrantParentsParams;
	    revokeParents?: RevokeParentsParams;
	    changePassword?: ChangePasswordParams;
	    setComment?: SetCommentParams;
	    setAttribute?: SetAttributeParams;
	    setConfig?: SetConfigParams;
	    resetConfig?: ResetConfigParams;
	
	    static createFrom(source: any = {}) {
	        return new OperationSpec(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.operation = source["operation"];
	        this.createRole = this.convertValues(source["createRole"], CreateRoleParams);
	        this.removeRole = this.convertValues(source["removeRole"], RemoveRoleParams);
	        this.renameRole = this.convertValues(source["renameRole"], RenameRoleParams);
	        this.grantParents = this.convertValues(source["grantParents"], GrantParentsParams);
	        this.revokeParents = this.convertValues(source["revokeParents"], RevokeParentsParams);
	        this.changePassword = this.convertValues(source["changePassword"], ChangePasswordParams);
	        this.setComment = this.convertValues(source["setComment"], SetCommentParams);
	        this.setAttribute = this.convertValues(source["setAttribute"], SetAttributeParams);
	        this.setConfig = this.convertValues(source["setConfig"], SetConfigParams);
	        this.resetConfig = this.convertValues(source["resetConfig"], ResetConfigParams);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class ClusterOps {
	    clusterId: string;
	    operations: OperationSpec[];
	
	    static createFrom(source: any = {}) {
	        return new ClusterOps(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.clusterId = source["clusterId"];
	        this.operations = this.convertValues(source["operations"], OperationSpec);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class ClusterResult {
	    clusterId: string;
	    alias: string;
	    host: string;
	    category: string;
	    status: string;
	    message: string;
	    durationMs: number;
	    queries?: string[];
	
	    static createFrom(source: any = {}) {
	        return new ClusterResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.clusterId = source["clusterId"];
	        this.alias = source["alias"];
	        this.host = source["host"];
	        this.category = source["category"];
	        this.status = source["status"];
	        this.message = source["message"];
	        this.durationMs = source["durationMs"];
	        this.queries = source["queries"];
	    }
	}
	export class RoleDependency {
	    database: string;
	    dependency: string;
	    class: string;
	    object: string;
	
	    static createFrom(source: any = {}) {
	        return new RoleDependency(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.database = source["database"];
	        this.dependency = source["dependency"];
	        this.class = source["class"];
	        this.object = source["object"];
	    }
	}
	export class ClusterRoleDependencies {
	    clusterId: string;
	    alias: string;
	    host: string;
	    category: string;
	    dependencies: RoleDependency[];
	    error?: string;
	    durationMs: number;
	    queries?: string[];
	
	    static createFrom(source: any = {}) {
	        return new ClusterRoleDependencies(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.clusterId = source["clusterId"];
	        this.alias = source["alias"];
	        this.host = source["host"];
	        this.category = source["category"];
	        this.dependencies = this.convertValues(source["dependencies"], RoleDependency);
	        this.error = source["error"];
	        this.durationMs = source["durationMs"];
	        this.queries = source["queries"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class ClusterRoleDetail {
	    clusterId: string;
	    alias: string;
	    host: string;
	    category: string;
	    exists: boolean;
	    comment: string;
	    parents: string[];
	    attributes: Record<string, boolean>;
	    settings: Record<string, string>;
	    error?: string;
	    durationMs: number;
	    queries?: string[];
	
	    static createFrom(source: any = {}) {
	        return new ClusterRoleDetail(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.clusterId = source["clusterId"];
	        this.alias = source["alias"];
	        this.host = source["host"];
	        this.category = source["category"];
	        this.exists = source["exists"];
	        this.comment = source["comment"];
	        this.parents = source["parents"];
	        this.attributes = source["attributes"];
	        this.settings = source["settings"];
	        this.error = source["error"];
	        this.durationMs = source["durationMs"];
	        this.queries = source["queries"];
	    }
	}
	export class RoleMatch {
	    clusterId: string;
	    alias: string;
	    host: string;
	    category: string;
	    loginName: string;
	    comment: string;
	
	    static createFrom(source: any = {}) {
	        return new RoleMatch(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.clusterId = source["clusterId"];
	        this.alias = source["alias"];
	        this.host = source["host"];
	        this.category = source["category"];
	        this.loginName = source["loginName"];
	        this.comment = source["comment"];
	    }
	}
	export class ClusterRoleMatches {
	    clusterId: string;
	    alias: string;
	    host: string;
	    category: string;
	    matches: RoleMatch[];
	    error?: string;
	    durationMs: number;
	    queries?: string[];
	
	    static createFrom(source: any = {}) {
	        return new ClusterRoleMatches(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.clusterId = source["clusterId"];
	        this.alias = source["alias"];
	        this.host = source["host"];
	        this.category = source["category"];
	        this.matches = this.convertValues(source["matches"], RoleMatch);
	        this.error = source["error"];
	        this.durationMs = source["durationMs"];
	        this.queries = source["queries"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class ClustersConfig {
	    clusters: Cluster[];
	    categories: Category[];
	
	    static createFrom(source: any = {}) {
	        return new ClustersConfig(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.clusters = this.convertValues(source["clusters"], Cluster);
	        this.categories = this.convertValues(source["categories"], Category);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class CommentField {
	    key: string;
	    label: string;
	
	    static createFrom(source: any = {}) {
	        return new CommentField(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.key = source["key"];
	        this.label = source["label"];
	    }
	}
	export class SearchColumn {
	    label: string;
	    template: string;
	
	    static createFrom(source: any = {}) {
	        return new SearchColumn(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.label = source["label"];
	        this.template = source["template"];
	    }
	}
	export class PasswordGen {
	    length: number;
	    lowercase: boolean;
	    uppercase: boolean;
	    digits: boolean;
	    symbols: boolean;
	    excludeSimilar: boolean;
	
	    static createFrom(source: any = {}) {
	        return new PasswordGen(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.length = source["length"];
	        this.lowercase = source["lowercase"];
	        this.uppercase = source["uppercase"];
	        this.digits = source["digits"];
	        this.symbols = source["symbols"];
	        this.excludeSimilar = source["excludeSimilar"];
	    }
	}
	export class UISettings {
	    theme: string;
	    commentDefaultView: string;
	    stageCreateOnTargetAdd: boolean;
	    suppressMd5RenameWarning: boolean;
	    checkForUpdates?: boolean;
	    passwordGen?: PasswordGen;
	
	    static createFrom(source: any = {}) {
	        return new UISettings(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.theme = source["theme"];
	        this.commentDefaultView = source["commentDefaultView"];
	        this.stageCreateOnTargetAdd = source["stageCreateOnTargetAdd"];
	        this.suppressMd5RenameWarning = source["suppressMd5RenameWarning"];
	        this.checkForUpdates = source["checkForUpdates"];
	        this.passwordGen = this.convertValues(source["passwordGen"], PasswordGen);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class DBRead {
	    query: string;
	
	    static createFrom(source: any = {}) {
	        return new DBRead(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.query = source["query"];
	    }
	}
	export class DBReads {
	    searchRoles: DBRead;
	    roleDetail: DBRead;
	    roleParents: DBRead;
	    roleDependencies: DBRead;
	
	    static createFrom(source: any = {}) {
	        return new DBReads(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.searchRoles = this.convertValues(source["searchRoles"], DBRead);
	        this.roleDetail = this.convertValues(source["roleDetail"], DBRead);
	        this.roleParents = this.convertValues(source["roleParents"], DBRead);
	        this.roleDependencies = this.convertValues(source["roleDependencies"], DBRead);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class DBFunction {
	    call: string;
	    execution?: string;
	    name?: string;
	    params?: string[];
	
	    static createFrom(source: any = {}) {
	        return new DBFunction(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.call = source["call"];
	        this.execution = source["execution"];
	        this.name = source["name"];
	        this.params = source["params"];
	    }
	}
	export class DBFunctions {
	    createRole: DBFunction;
	    removeRole: DBFunction;
	    renameRole: DBFunction;
	    grantParents: DBFunction;
	    revokeParents: DBFunction;
	    changePassword: DBFunction;
	    setComment: DBFunction;
	    setAttribute: DBFunction;
	    setConfig: DBFunction;
	    resetConfig: DBFunction;
	
	    static createFrom(source: any = {}) {
	        return new DBFunctions(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.createRole = this.convertValues(source["createRole"], DBFunction);
	        this.removeRole = this.convertValues(source["removeRole"], DBFunction);
	        this.renameRole = this.convertValues(source["renameRole"], DBFunction);
	        this.grantParents = this.convertValues(source["grantParents"], DBFunction);
	        this.revokeParents = this.convertValues(source["revokeParents"], DBFunction);
	        this.changePassword = this.convertValues(source["changePassword"], DBFunction);
	        this.setComment = this.convertValues(source["setComment"], DBFunction);
	        this.setAttribute = this.convertValues(source["setAttribute"], DBFunction);
	        this.setConfig = this.convertValues(source["setConfig"], DBFunction);
	        this.resetConfig = this.convertValues(source["resetConfig"], DBFunction);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class TargetSelection {
	    categoryIds: string[];
	    clusterIds: string[];
	
	    static createFrom(source: any = {}) {
	        return new TargetSelection(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.categoryIds = source["categoryIds"];
	        this.clusterIds = source["clusterIds"];
	    }
	}
	export class Config {
	    version: number;
	    categories: Category[];
	    clusters: Cluster[];
	    targets: TargetSelection;
	    dbFunctions: DBFunctions;
	    dbReads: DBReads;
	    batch: BatchSettings;
	    ui: UISettings;
	    parentRoles: string[];
	    commentFields: CommentField[];
	    searchColumns: SearchColumn[];
	    windowWidth?: number;
	    windowHeight?: number;
	    updateSeenVersion?: string;
	
	    static createFrom(source: any = {}) {
	        return new Config(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.version = source["version"];
	        this.categories = this.convertValues(source["categories"], Category);
	        this.clusters = this.convertValues(source["clusters"], Cluster);
	        this.targets = this.convertValues(source["targets"], TargetSelection);
	        this.dbFunctions = this.convertValues(source["dbFunctions"], DBFunctions);
	        this.dbReads = this.convertValues(source["dbReads"], DBReads);
	        this.batch = this.convertValues(source["batch"], BatchSettings);
	        this.ui = this.convertValues(source["ui"], UISettings);
	        this.parentRoles = source["parentRoles"];
	        this.commentFields = this.convertValues(source["commentFields"], CommentField);
	        this.searchColumns = this.convertValues(source["searchColumns"], SearchColumn);
	        this.windowWidth = source["windowWidth"];
	        this.windowHeight = source["windowHeight"];
	        this.updateSeenVersion = source["updateSeenVersion"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	
	
	
	
	
	export class DefaultTemplates {
	    dbFunctions: DBFunctions;
	    dbReads: DBReads;
	
	    static createFrom(source: any = {}) {
	        return new DefaultTemplates(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.dbFunctions = this.convertValues(source["dbFunctions"], DBFunctions);
	        this.dbReads = this.convertValues(source["dbReads"], DBReads);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	
	
	
	
	
	
	
	export class RoleBatchRequest {
	    clusters: ClusterOps[];
	    auth: AuthContext;
	    confirmProduction: boolean;
	
	    static createFrom(source: any = {}) {
	        return new RoleBatchRequest(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.clusters = this.convertValues(source["clusters"], ClusterOps);
	        this.auth = this.convertValues(source["auth"], AuthContext);
	        this.confirmProduction = source["confirmProduction"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class RoleDependenciesRequest {
	    loginName: string;
	    categoryIds: string[];
	    clusterIds: string[];
	    auth: AuthContext;
	
	    static createFrom(source: any = {}) {
	        return new RoleDependenciesRequest(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.loginName = source["loginName"];
	        this.categoryIds = source["categoryIds"];
	        this.clusterIds = source["clusterIds"];
	        this.auth = this.convertValues(source["auth"], AuthContext);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	
	export class RoleDetailsRequest {
	    loginName: string;
	    categoryIds: string[];
	    clusterIds: string[];
	    auth: AuthContext;
	
	    static createFrom(source: any = {}) {
	        return new RoleDetailsRequest(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.loginName = source["loginName"];
	        this.categoryIds = source["categoryIds"];
	        this.clusterIds = source["clusterIds"];
	        this.auth = this.convertValues(source["auth"], AuthContext);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	
	export class RoleSearchRequest {
	    term: string;
	    categoryIds: string[];
	    clusterIds: string[];
	    auth: AuthContext;
	
	    static createFrom(source: any = {}) {
	        return new RoleSearchRequest(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.term = source["term"];
	        this.categoryIds = source["categoryIds"];
	        this.clusterIds = source["clusterIds"];
	        this.auth = this.convertValues(source["auth"], AuthContext);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class RunRequest {
	    operation: string;
	    createRole?: CreateRoleParams;
	    removeRole?: RemoveRoleParams;
	    renameRole?: RenameRoleParams;
	    grantParents?: GrantParentsParams;
	    revokeParents?: RevokeParentsParams;
	    changePassword?: ChangePasswordParams;
	    setComment?: SetCommentParams;
	    setAttribute?: SetAttributeParams;
	    setConfig?: SetConfigParams;
	    resetConfig?: ResetConfigParams;
	    categoryIds: string[];
	    clusterIds: string[];
	    auth: AuthContext;
	    confirmProduction: boolean;
	
	    static createFrom(source: any = {}) {
	        return new RunRequest(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.operation = source["operation"];
	        this.createRole = this.convertValues(source["createRole"], CreateRoleParams);
	        this.removeRole = this.convertValues(source["removeRole"], RemoveRoleParams);
	        this.renameRole = this.convertValues(source["renameRole"], RenameRoleParams);
	        this.grantParents = this.convertValues(source["grantParents"], GrantParentsParams);
	        this.revokeParents = this.convertValues(source["revokeParents"], RevokeParentsParams);
	        this.changePassword = this.convertValues(source["changePassword"], ChangePasswordParams);
	        this.setComment = this.convertValues(source["setComment"], SetCommentParams);
	        this.setAttribute = this.convertValues(source["setAttribute"], SetAttributeParams);
	        this.setConfig = this.convertValues(source["setConfig"], SetConfigParams);
	        this.resetConfig = this.convertValues(source["resetConfig"], ResetConfigParams);
	        this.categoryIds = source["categoryIds"];
	        this.clusterIds = source["clusterIds"];
	        this.auth = this.convertValues(source["auth"], AuthContext);
	        this.confirmProduction = source["confirmProduction"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	
	
	
	
	export class SettingsPayload {
	    parentRoles: string[];
	    commentFields: CommentField[];
	    searchColumns: SearchColumn[];
	    dbFunctions: DBFunctions;
	    dbReads: DBReads;
	    batch: BatchSettings;
	    ui: UISettings;
	
	    static createFrom(source: any = {}) {
	        return new SettingsPayload(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.parentRoles = source["parentRoles"];
	        this.commentFields = this.convertValues(source["commentFields"], CommentField);
	        this.searchColumns = this.convertValues(source["searchColumns"], SearchColumn);
	        this.dbFunctions = this.convertValues(source["dbFunctions"], DBFunctions);
	        this.dbReads = this.convertValues(source["dbReads"], DBReads);
	        this.batch = this.convertValues(source["batch"], BatchSettings);
	        this.ui = this.convertValues(source["ui"], UISettings);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	
	export class TestConnectionRequest {
	    clusterId: string;
	    auth: AuthContext;
	
	    static createFrom(source: any = {}) {
	        return new TestConnectionRequest(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.clusterId = source["clusterId"];
	        this.auth = this.convertValues(source["auth"], AuthContext);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	
	export class UpdateInfo {
	    currentVersion: string;
	    latestVersion: string;
	    updateAvailable: boolean;
	    releaseURL: string;
	    releaseName?: string;
	    notes?: string;
	
	    static createFrom(source: any = {}) {
	        return new UpdateInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.currentVersion = source["currentVersion"];
	        this.latestVersion = source["latestVersion"];
	        this.updateAvailable = source["updateAvailable"];
	        this.releaseURL = source["releaseURL"];
	        this.releaseName = source["releaseName"];
	        this.notes = source["notes"];
	    }
	}

}

